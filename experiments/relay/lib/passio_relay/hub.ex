defmodule PassioRelay.Hub do
  use GenServer

  alias PassioRelay.{Config, Wire}

  def start_link(_), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)

  def draining?, do: :persistent_term.get({__MODULE__, :draining}, false)

  def register(endpoint_id, pid), do: GenServer.call(__MODULE__, {:register, endpoint_id, pid})

  def unregister(endpoint_id, pid), do: GenServer.call(__MODULE__, {:unregister, endpoint_id, pid})

  def reserve(endpoint_id), do: GenServer.call(__MODULE__, {:reserve, endpoint_id})

  def attach_client(connection_id, pid), do: GenServer.call(__MODULE__, {:attach_client, connection_id, pid})

  def claim(endpoint_id, connection_id, token),
    do: GenServer.call(__MODULE__, {:claim, endpoint_id, connection_id, token})

  def attach_host(connection_id, pid), do: GenServer.call(__MODULE__, {:attach_host, connection_id, pid})

  def release(connection_id, pid, code, reason),
    do: GenServer.cast(__MODULE__, {:release, connection_id, pid, code, reason})

  def stats, do: GenServer.call(__MODULE__, :stats)

  def begin_drain, do: GenServer.call(__MODULE__, :begin_drain)

  def await_idle(timeout) do
    GenServer.call(__MODULE__, :await_idle, timeout)
  catch
    :exit, {:timeout, _} -> :timeout
  end

  def close_all, do: GenServer.call(__MODULE__, :close_all)

  @impl true
  def init(nil) do
    {:ok, %{hosts: %{}, pairs: %{}, monitors: %{}, idle_waiters: []}}
  end

  @impl true
  def handle_call({:register, endpoint_id, pid}, _from, state) do
    cond do
      draining?() ->
        {:reply, {:error, :draining}, state}

      Map.has_key?(state.hosts, endpoint_id) ->
        {:reply, {:error, :taken}, state}

      true ->
        mon = Process.monitor(pid)
        outbox = :atomics.new(1, signed: true)
        host = %{pid: pid, mon: mon, gen: make_ref(), pairs: MapSet.new(), outbox: outbox}

        state =
          state
          |> put_in([:hosts, endpoint_id], host)
          |> put_in([:monitors, mon], {:host, endpoint_id})

        {:reply, {:ok, outbox}, state}
    end
  end

  def handle_call({:unregister, endpoint_id, pid}, _from, state) do
    case state.hosts do
      %{^endpoint_id => %{pid: ^pid, mon: mon}} -> {:reply, :ok, drop_host(state, mon, endpoint_id)}
      _ -> {:reply, :ok, state}
    end
  end

  def handle_call({:reserve, endpoint_id}, _from, state) do
    config = Config.get()
    host = Map.get(state.hosts, endpoint_id)

    cond do
      draining?() ->
        {:reply, {:error, :draining}, state}

      host == nil ->
        {:reply, {:error, :not_found}, state}

      map_size(state.pairs) >= config.max_clients ->
        {:reply, {:error, :limit}, state}

      MapSet.size(host.pairs) >= config.max_clients_per_host ->
        {:reply, {:error, :limit}, state}

      pending_count(state, host) >= config.max_pending_per_host ->
        {:reply, {:error, :limit}, state}

      true ->
        connection_id = Wire.random(16)
        tag = make_ref()
        timer = Process.send_after(self(), {:pair_timeout, connection_id, tag}, config.pair_timeout_ms)

        pair = %{
          endpoint_id: endpoint_id,
          gen: host.gen,
          status: :reserved,
          token: nil,
          mons: [],
          client: nil,
          host: nil,
          timer: timer,
          tag: tag,
          c2h: :atomics.new(2, signed: true),
          h2c: :atomics.new(2, signed: true)
        }

        state =
          state
          |> put_in([:pairs, connection_id], pair)
          |> update_in([:hosts, endpoint_id, :pairs], &MapSet.put(&1, connection_id))

        {:reply, {:ok, connection_id}, state}
    end
  end

  def handle_call({:attach_client, connection_id, pid}, _from, state) do
    case state.pairs do
      %{^connection_id => %{status: :reserved} = pair} ->
        token = Wire.random(32)

        case notify(state.hosts[pair.endpoint_id], %{type: "incoming", connectionId: connection_id, token: token}) do
          :ok ->
            mon = Process.monitor(pid)
            pair = %{pair | status: :waiting, token: token, client: pid, mons: [mon]}

            state =
              state
              |> put_in([:pairs, connection_id], pair)
              |> put_in([:monitors, mon], {:pair, connection_id})

            {:reply, {:ok, pair.c2h, pair.h2c}, state}

          :overflow ->
            {:reply, :error, evict(state, pair.endpoint_id)}
        end

      _ ->
        {:reply, :error, state}
    end
  end

  def handle_call({:claim, endpoint_id, connection_id, token}, _from, state) do
    pair = Map.get(state.pairs, connection_id)
    host = Map.get(state.hosts, endpoint_id)

    cond do
      draining?() ->
        {:reply, {:error, :draining}, state}

      pair == nil or host == nil or pair.endpoint_id != endpoint_id or pair.gen != host.gen ->
        {:reply, {:error, :not_found}, state}

      pair.status != :waiting or not token_matches?(pair.token, token) ->
        {:reply, {:error, :forbidden}, state}

      true ->
        {:reply, :ok, put_in(state.pairs[connection_id], %{pair | status: :claimed, token: nil})}
    end
  end

  def handle_call({:attach_host, connection_id, pid}, _from, state) do
    case state.pairs do
      %{^connection_id => %{status: :claimed} = pair} ->
        Process.cancel_timer(pair.timer)
        mon = Process.monitor(pid)
        send(pair.client, {:paired, pid})

        state =
          state
          |> put_in([:pairs, connection_id], %{pair | status: :active, host: pid, timer: nil, mons: [mon | pair.mons]})
          |> put_in([:monitors, mon], {:pair, connection_id})

        {:reply, {:ok, pair.client, pair.c2h, pair.h2c}, state}

      _ ->
        {:reply, :error, state}
    end
  end

  def handle_call(:stats, _from, state) do
    active = Enum.count(state.pairs, fn {_, pair} -> pair.status == :active end)

    {:reply,
     %{
       activeHosts: map_size(state.hosts),
       activePairs: active,
       pendingPairs: map_size(state.pairs) - active
     }, state}
  end

  def handle_call(:begin_drain, _from, state) do
    :persistent_term.put({__MODULE__, :draining}, true)

    state =
      state.pairs
      |> Enum.reject(fn {_, pair} -> pair.status == :active end)
      |> Enum.reduce(state, fn {id, _}, acc -> drop_pair(acc, id, 1001, "relay draining", true) end)

    {:reply, :ok, state}
  end

  def handle_call(:await_idle, from, state) do
    if map_size(state.pairs) == 0 do
      {:reply, :ok, state}
    else
      {:noreply, %{state | idle_waiters: [from | state.idle_waiters]}}
    end
  end

  def handle_call(:close_all, _from, state) do
    pids =
      Enum.flat_map(state.pairs, fn {_, pair} -> Enum.reject([pair.client, pair.host], &is_nil/1) end) ++
        Enum.map(state.hosts, fn {_, host} -> host.pid end)

    Enum.each(pids, &send(&1, {:relay_close, 1001, "relay shutting down"}))
    {:reply, pids, state}
  end

  @impl true
  def handle_cast({:release, connection_id, pid, code, reason}, state) do
    case state.pairs do
      %{^connection_id => pair} when pair.client == pid or pair.host == pid ->
        {:noreply, drop_pair(state, connection_id, code, reason, true)}

      _ ->
        {:noreply, state}
    end
  end

  @impl true
  def handle_info({:DOWN, mon, :process, _, _}, state) do
    case Map.get(state.monitors, mon) do
      {:host, endpoint_id} -> {:noreply, drop_host(state, mon, endpoint_id)}
      {:pair, id} -> {:noreply, drop_pair(state, id, 1011, "peer connection lost", true)}
      nil -> {:noreply, state}
    end
  end

  def handle_info({:pair_timeout, connection_id, tag}, state) do
    case state.pairs do
      %{^connection_id => %{tag: ^tag, status: status}} when status != :active ->
        {:noreply, drop_pair(state, connection_id, 1013, "pair timeout", true)}

      _ ->
        {:noreply, state}
    end
  end

  defp drop_host(state, mon, endpoint_id) do
    host = state.hosts[endpoint_id]
    Process.demonitor(mon, [:flush])

    state =
      Enum.reduce(host.pairs, state, fn id, acc -> drop_pair(acc, id, 1001, "host disconnected", false) end)

    %{state | hosts: Map.delete(state.hosts, endpoint_id), monitors: Map.delete(state.monitors, mon)}
    |> notify_idle()
  end

  defp drop_pair(state, connection_id, code, reason, notify?) do
    case Map.pop(state.pairs, connection_id) do
      {nil, _} ->
        state

      {pair, pairs} ->
        if pair.timer, do: Process.cancel_timer(pair.timer)
        for pid <- [pair.client, pair.host], pid != nil, do: send(pid, {:relay_close, code, reason})
        Enum.each(pair.mons, &Process.demonitor(&1, [:flush]))

        {hosts, notified} =
          case Map.fetch(state.hosts, pair.endpoint_id) do
            {:ok, host} ->
              notified =
                if notify? and pair.status != :reserved,
                  do: notify(host, %{type: "closed", connectionId: connection_id}),
                  else: :ok

              {Map.put(state.hosts, pair.endpoint_id, %{host | pairs: MapSet.delete(host.pairs, connection_id)}),
               notified}

            :error ->
              {state.hosts, :ok}
          end

        state = notify_idle(%{state | pairs: pairs, monitors: Map.drop(state.monitors, pair.mons), hosts: hosts})
        if notified == :overflow, do: evict(state, pair.endpoint_id), else: state
    end
  end

  defp notify(host, record) do
    frame = JSON.encode!(record)

    if :atomics.add_get(host.outbox, 1, byte_size(frame)) > Config.get().max_queue_bytes do
      :overflow
    else
      send(host.pid, {:notify, frame})
      :ok
    end
  end

  defp evict(state, endpoint_id) do
    host = state.hosts[endpoint_id]
    send(host.pid, {:relay_close, 1013, "control queue limit exceeded"})
    drop_host(state, host.mon, endpoint_id)
  end

  defp notify_idle(%{idle_waiters: [_ | _] = waiters, pairs: pairs} = state) when map_size(pairs) == 0 do
    Enum.each(waiters, &GenServer.reply(&1, :ok))
    %{state | idle_waiters: []}
  end

  defp notify_idle(state), do: state

  defp pending_count(state, host) do
    Enum.count(host.pairs, fn id -> state.pairs[id].status != :active end)
  end

  defp token_matches?(expected, given)
       when is_binary(expected) and is_binary(given) and byte_size(expected) == byte_size(given),
       do: :crypto.hash_equals(expected, given)

  defp token_matches?(_, _), do: false
end
