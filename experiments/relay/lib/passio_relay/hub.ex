defmodule PassioRelay.Hub do
  use GenServer
  alias PassioRelay.{Identity, Outbox, Pair}
  @control_limits %{max_queue_bytes: 262_144, max_queue_messages: 256}

  def start_link(config), do: GenServer.start_link(__MODULE__, config, name: __MODULE__)
  def admit(path, params, ip), do: GenServer.call(__MODULE__, {:admit, path, params, ip})
  def attach(lease), do: GenServer.call(__MODULE__, {:attach, lease, self()})

  def register(lease, endpoint),
    do: GenServer.call(__MODULE__, {:register, lease, endpoint, self()})

  def connected(id, pid), do: GenServer.cast(__MODULE__, {:connected, id, pid})
  def metrics, do: GenServer.call(__MODULE__, :metrics)
  def accepting?, do: GenServer.call(__MODULE__, :accepting)
  def reject, do: :counters.add(:persistent_term.get(__MODULE__), 3, 1)

  def forwarded(size) do
    counters = :persistent_term.get(__MODULE__)
    :counters.add(counters, 1, 1)
    :counters.add(counters, 2, size)
  end

  @impl true
  def init(config) do
    :persistent_term.put(__MODULE__, :counters.new(3, [:write_concurrency]))
    Process.send_after(self(), :expire_ips, 1000)

    {:ok,
     %{
       config: config,
       controls: %{},
       hosts: %{},
       pairs: %{},
       refs: %{},
       ips: %{},
       draining: false
     }}
  end

  @impl true
  def handle_call(:accepting, _, state), do: {:reply, not state.draining, state}

  def handle_call(:metrics, _, state) do
    counters = :persistent_term.get(__MODULE__)
    pending = Enum.count(state.pairs, fn {_, pair} -> pair.pending end)

    metrics = %{
      activeHosts: map_size(state.hosts),
      activePairs: map_size(state.pairs) - pending,
      pendingPairs: pending,
      forwardedMessages: :counters.get(counters, 1),
      forwardedBytes: :counters.get(counters, 2),
      rejectedConnections: :counters.get(counters, 3),
      admissionIPs: map_size(state.ips),
      controlConnections: map_size(state.controls)
    }

    {:reply, metrics, state}
  end

  def handle_call({:admit, path, params, ip}, _, state) do
    {allowed, state} = rate(state, ip)

    cond do
      state.draining -> rejected(503, state)
      not allowed -> rejected(429, state)
      true -> admit_route(path, params, state)
    end
  end

  def handle_call({:attach, lease, pid}, _, state) do
    case state.controls[lease] do
      %{pid: nil, deadline: deadline} = control ->
        if now() < deadline and not state.draining do
          ref = Process.monitor(pid)
          controls = Map.put(state.controls, lease, %{control | pid: pid})

          {:reply, :ok,
           %{state | controls: controls, refs: Map.put(state.refs, ref, {:control, lease})}}
        else
          {:reply, :closed, drop_control(state, lease, 1008, "authentication timeout")}
        end

      _ ->
        {:reply, :closed, state}
    end
  end

  def handle_call({:register, lease, endpoint, pid}, _, state) do
    case state.controls[lease] do
      %{pid: ^pid, endpoint: nil} = control ->
        cond do
          state.draining or now() >= control.deadline ->
            reject()
            {:reply, :closed, drop_control(state, lease, 1008, "authentication timeout")}

          Map.has_key?(state.hosts, endpoint) ->
            reject()
            {:reply, :duplicate, state}

          true ->
            Process.cancel_timer(control.timer)
            controls = Map.put(state.controls, lease, %{control | endpoint: endpoint})

            {:reply, :ok,
             %{state | controls: controls, hosts: Map.put(state.hosts, endpoint, lease)}}
        end

      _ ->
        {:reply, :closed, state}
    end
  end

  defp admit_route("/v1/control", params, state) do
    with {:ok, key} <- Identity.decode(params["publicKey"], 32),
         true <- map_size(state.controls) < state.config.max_clients do
      lease = make_ref()
      timer = Process.send_after(self(), {:auth_timeout, lease}, state.config.auth_timeout_ms)

      control = %{
        pid: nil,
        endpoint: nil,
        box: Outbox.new(),
        timer: timer,
        deadline: now() + state.config.auth_timeout_ms
      }

      {:reply, {:ok, {:control, lease, key}},
       %{state | controls: Map.put(state.controls, lease, control)}}
    else
      false -> rejected(503, state)
      _ -> rejected(400, state)
    end
  end

  defp admit_route("/v1/connect", params, state) do
    endpoint = params["endpointId"]

    with true <- Identity.valid_endpoint?(endpoint),
         lease when not is_nil(lease) <- state.hosts[endpoint] do
      host_pairs = Enum.filter(state.pairs, fn {_, pair} -> pair.generation == lease end)
      pending = Enum.count(host_pairs, fn {_, pair} -> pair.pending end)

      if map_size(state.pairs) >= state.config.max_clients or
           length(host_pairs) >= state.config.max_clients_per_host or
           pending >= state.config.max_pending_per_host do
        rejected(429, state)
      else
        id = Identity.random(16)
        token = Identity.random(32)
        deadline = now() + state.config.pair_timeout_ms

        {:ok, pid} =
          DynamicSupervisor.start_child(PassioRelay.Pairs, {Pair, {state.config, deadline}})

        ref = Process.monitor(pid)

        pair = %{
          pid: pid,
          endpoint: endpoint,
          generation: lease,
          token: token,
          pending: true,
          deadline: deadline,
          announced: false
        }

        {:reply, {:ok, {:data, pid, :client, id}},
         %{
           state
           | pairs: Map.put(state.pairs, id, pair),
             refs: Map.put(state.refs, ref, {:pair, id, pid})
         }}
      end
    else
      _ -> rejected(404, state)
    end
  end

  defp admit_route("/v1/accept", params, state) do
    id = params["connectionId"]
    endpoint = params["endpointId"]

    with true <- Identity.valid_endpoint?(endpoint),
         {:ok, _} <- Identity.decode(id, 16),
         {:ok, _} <- Identity.decode(params["token"], 32),
         %{endpoint: ^endpoint, pending: true} = pair <- state.pairs[id],
         true <- pair.generation == state.hosts[endpoint] and now() < pair.deadline,
         true <- :crypto.hash_equals(pair.token, params["token"]) do
      {:reply, {:ok, {:data, pair.pid, :host, id}},
       %{state | pairs: Map.put(state.pairs, id, %{pair | pending: false, token: nil})}}
    else
      _ -> rejected(403, state)
    end
  end

  defp admit_route(_, _, state), do: rejected(404, state)

  @impl true
  def handle_cast({:connected, id, pid}, state) do
    case state.pairs[id] do
      %{pid: ^pid, announced: false} = pair ->
        state = %{state | pairs: Map.put(state.pairs, id, %{pair | announced: true})}

        {:noreply,
         notify(state, pair.generation, %{type: "incoming", connectionId: id, token: pair.token})}

      _ ->
        {:noreply, state}
    end
  end

  def handle_cast({:ack, lease, ref}, state) do
    case state.controls[lease] do
      nil ->
        {:noreply, state}

      control ->
        case Outbox.ack(control.box, ref) do
          {:ok, box, _} ->
            box = Outbox.dispatch(box, control.pid, self(), lease, state.config.write_timeout_ms)
            {:noreply, put_in(state.controls[lease].box, box)}

          :stale ->
            {:noreply, state}
        end
    end
  end

  @impl true
  def handle_info({:DOWN, ref, :process, _, _}, state) do
    case Map.pop(state.refs, ref) do
      {{:control, lease}, refs} ->
        {:noreply, drop_control(%{state | refs: refs}, lease, 1001, "host disconnected")}

      {{:pair, id, pid}, refs} ->
        state = %{state | refs: refs}

        case state.pairs[id] do
          %{pid: ^pid} = pair ->
            state = %{state | pairs: Map.delete(state.pairs, id)}
            state = notify(state, pair.generation, %{type: "closed", connectionId: id})
            if state.draining and map_size(state.pairs) == 0, do: send(self(), :finish_drain)
            {:noreply, state}

          _ ->
            {:noreply, state}
        end

      {nil, _} ->
        {:noreply, state}
    end
  end

  def handle_info({:auth_timeout, lease}, state) do
    case state.controls[lease] do
      %{endpoint: nil} ->
        reject()
        {:noreply, drop_control(state, lease, 1008, "authentication timeout")}

      _ ->
        {:noreply, state}
    end
  end

  def handle_info({:write_timeout, lease, ref}, state) do
    case state.controls[lease] do
      %{box: box} ->
        if Outbox.expired?(box, ref),
          do: {:noreply, drop_control(state, lease, 1013, "write timeout")},
          else: {:noreply, state}

      _ ->
        {:noreply, state}
    end
  end

  def handle_info(:expire_ips, state) do
    Process.send_after(self(), :expire_ips, 1000)
    {:noreply, %{state | ips: Map.reject(state.ips, fn {_, {_, at}} -> now() - at >= 60_000 end)}}
  end

  def handle_info(:drain, %{draining: false} = state) do
    IO.puts(:stderr, Jason.encode!(%{event: "draining"}))
    Process.send_after(self(), :finish_drain, 4750)
    if map_size(state.pairs) == 0, do: send(self(), :finish_drain)
    {:noreply, %{state | draining: true}}
  end

  def handle_info(:drain, state), do: {:noreply, state}

  def handle_info(:finish_drain, state) do
    for {_, pair} <- state.pairs, do: Pair.close(pair.pid, 1001, "relay draining")

    for {_, control} <- state.controls,
        is_pid(control.pid),
        do: send(control.pid, {:close, 1001, "relay draining"})

    Process.send_after(self(), :stop, 50)
    {:noreply, state}
  end

  def handle_info(:stop, state) do
    :init.stop()
    {:noreply, state}
  end

  defp notify(state, lease, message) do
    case state.controls[lease] do
      %{pid: pid} = control when is_pid(pid) ->
        case Outbox.put(control.box, {:text, Jason.encode!(message)}, @control_limits) do
          {:ok, box} ->
            box = Outbox.dispatch(box, pid, self(), lease, state.config.write_timeout_ms)
            put_in(state.controls[lease].box, box)

          :full ->
            drop_control(state, lease, 1013, "control queue limit")
        end

      _ ->
        state
    end
  end

  defp drop_control(state, lease, code, reason) do
    case Map.pop(state.controls, lease) do
      {nil, _} ->
        state

      {control, controls} ->
        Process.cancel_timer(control.timer)
        if is_pid(control.pid), do: send(control.pid, {:close, code, reason})

        for {_, pair} <- state.pairs,
            pair.generation == lease,
            do: Pair.close(pair.pid, code, reason)

        hosts =
          if state.hosts[control.endpoint] == lease,
            do: Map.delete(state.hosts, control.endpoint),
            else: state.hosts

        %{state | controls: controls, hosts: hosts}
    end
  end

  defp rate(state, ip) do
    at = now()
    capacity = state.config.admission_rate

    case Map.get(state.ips, ip) do
      nil when map_size(state.ips) >= 4096 ->
        {false, state}

      entry ->
        {tokens, previous} = entry || {capacity, at}
        tokens = min(capacity, tokens + (at - previous) * capacity / 1000)
        allowed = tokens >= 1
        tokens = if allowed, do: tokens - 1, else: tokens
        {allowed, %{state | ips: Map.put(state.ips, ip, {tokens, at})}}
    end
  end

  defp rejected(status, state) do
    reject()
    {:reply, {:error, status}, state}
  end

  defp now, do: System.monotonic_time(:millisecond)
end
