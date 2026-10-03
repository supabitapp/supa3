defmodule Relay.Registry do
  use GenServer

  alias Relay.Encoding

  def start_link(opts), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  def register(endpoint_id, pid), do: GenServer.call(__MODULE__, {:register, endpoint_id, pid})
  def admit_client(endpoint_id, pid), do: GenServer.call(__MODULE__, {:admit_client, endpoint_id, pid})
  def check_admit(endpoint_id), do: GenServer.call(__MODULE__, {:admit_client, endpoint_id, nil})

  def accept(endpoint_id, connection_id, token, pid),
    do: GenServer.call(__MODULE__, {:accept, endpoint_id, connection_id, token, pid})

  def check_accept(endpoint_id, connection_id, token),
    do: GenServer.call(__MODULE__, {:accept, endpoint_id, connection_id, token, nil})

  def control_ack(endpoint_id, pid), do: GenServer.cast(__MODULE__, {:control_ack, endpoint_id, pid})
  def stats, do: GenServer.call(__MODULE__, :stats)
  def close_all(code, reason), do: GenServer.call(__MODULE__, {:close_all, code, reason})

  @impl true
  def init(_opts) do
    {:ok, %{cfg: Relay.Config.get(), hosts: %{}, pairs: %{}, refs: %{}, gen: 0, total: 0}}
  end

  @impl true
  def handle_call({:register, endpoint_id, pid}, _from, state) do
    cond do
      Relay.Drain.draining?() ->
        {:reply, {:error, :draining}, state}

      Map.has_key?(state.hosts, endpoint_id) ->
        {:reply, {:error, :taken}, state}

      true ->
        gen = state.gen + 1
        ref = Process.monitor(pid)
        host = %{pid: pid, gen: gen, ref: ref, pairs: MapSet.new(), pending: 0, unacked: 0}

        state = %{
          state
          | gen: gen,
            hosts: Map.put(state.hosts, endpoint_id, host),
            refs: Map.put(state.refs, ref, {:host, endpoint_id})
        }

        {:reply, {:ok, gen}, state}
    end
  end

  def handle_call({:admit_client, endpoint_id, pid}, _from, state) do
    cfg = state.cfg
    host = Map.get(state.hosts, endpoint_id)

    cond do
      Relay.Drain.draining?() -> {:reply, {:error, :draining}, state}
      host == nil -> {:reply, {:error, :no_host}, state}
      state.total >= cfg.max_clients -> {:reply, {:error, :limit}, state}
      MapSet.size(host.pairs) >= cfg.max_clients_per_host -> {:reply, {:error, :limit}, state}
      host.pending >= cfg.max_pending_per_host -> {:reply, {:error, :limit}, state}
      host.unacked >= cfg.max_queue_messages -> {:reply, {:error, :limit}, state}
      pid == nil -> {:reply, :ok, state}
      true ->
        {state, pair} = new_pair(state, endpoint_id, host, pid)
        {:reply, {:ok, pair.id}, state}
    end
  end

  def handle_call({:accept, endpoint_id, connection_id, token, pid}, _from, state) do
    host = Map.get(state.hosts, endpoint_id)
    pair = Map.get(state.pairs, connection_id)

    cond do
      Relay.Drain.draining?() ->
        {:reply, {:error, :not_found}, state}

      host == nil or pair == nil or pair.endpoint_id != endpoint_id ->
        {:reply, {:error, :not_found}, state}

      pair.status != :pending or pair.gen != host.gen or not :crypto.hash_equals(pair.token, token) ->
        {:reply, {:error, :forbidden}, state}

      pid == nil ->
        {:reply, :ok, state}

      true ->
        Process.cancel_timer(pair.timer)
        ref = Process.monitor(pid)
        pair = %{pair | status: :active, host_pid: pid, host_ref: ref, token: :used, timer: nil}
        send(pair.client_pid, {:paired, pid})

        state = %{
          state
          | pairs: Map.put(state.pairs, connection_id, pair),
            refs: Map.put(state.refs, ref, {:host_data, connection_id}),
            hosts: Map.update!(state.hosts, endpoint_id, &%{&1 | pending: &1.pending - 1})
        }

        {:reply, {:ok, pair.client_pid}, state}
    end
  end

  def handle_call(:stats, _from, state) do
    pending = Enum.count(state.pairs, fn {_, p} -> p.status == :pending end)

    {:reply,
     %{activeHosts: map_size(state.hosts), activePairs: map_size(state.pairs) - pending, pendingPairs: pending},
     state}
  end

  def handle_call({:close_all, code, reason}, _from, state) do
    for {_, pair} <- state.pairs, pid <- [pair.client_pid, pair.host_pid], pid != nil do
      send(pid, {:relay_close, code, reason})
    end

    for {_, host} <- state.hosts, do: send(host.pid, {:relay_close, code, reason})
    {:reply, :ok, state}
  end

  @impl true
  def handle_cast({:control_ack, endpoint_id, pid}, state) do
    case Map.get(state.hosts, endpoint_id) do
      %{pid: ^pid, unacked: n} = host when n > 0 ->
        {:noreply, %{state | hosts: Map.put(state.hosts, endpoint_id, %{host | unacked: n - 1})}}

      _ ->
        {:noreply, state}
    end
  end

  @impl true
  def handle_info({:DOWN, ref, :process, _pid, _reason}, state) do
    case Map.pop(state.refs, ref) do
      {nil, _} -> {:noreply, state}
      {{:host, endpoint_id}, refs} -> {:noreply, host_down(%{state | refs: refs}, endpoint_id)}
      {{_role, connection_id}, refs} -> {:noreply, release(%{state | refs: refs}, connection_id, 1001, "peer closed")}
    end
  end

  def handle_info({:pair_timeout, connection_id, client_pid}, state) do
    case Map.get(state.pairs, connection_id) do
      %{status: :pending, client_pid: ^client_pid} -> {:noreply, release(state, connection_id, 1001, "pairing timeout")}
      _ -> {:noreply, state}
    end
  end

  defp new_pair(state, endpoint_id, host, pid) do
    id = Encoding.encode(:crypto.strong_rand_bytes(16))
    token = Encoding.encode(:crypto.strong_rand_bytes(32))
    ref = Process.monitor(pid)

    pair = %{
      id: id,
      endpoint_id: endpoint_id,
      gen: host.gen,
      token: token,
      status: :pending,
      client_pid: pid,
      client_ref: ref,
      host_pid: nil,
      host_ref: nil,
      timer: Process.send_after(self(), {:pair_timeout, id, pid}, state.cfg.pair_timeout_ms)
    }

    host = notify(host, %{type: "incoming", connectionId: id, token: token})
    host = %{host | pairs: MapSet.put(host.pairs, id), pending: host.pending + 1}

    state = %{
      state
      | total: state.total + 1,
        pairs: Map.put(state.pairs, id, pair),
        refs: Map.put(state.refs, ref, {:client, id}),
        hosts: Map.put(state.hosts, endpoint_id, host)
    }

    {state, pair}
  end

  defp notify(host, record) do
    send(host.pid, {:control, record})
    unacked = host.unacked + 1

    if unacked > Relay.Config.get().max_queue_messages do
      Process.exit(host.pid, {:shutdown, :control_queue_full})
    end

    %{host | unacked: unacked}
  end

  defp host_down(state, endpoint_id) do
    {host, hosts} = Map.pop(state.hosts, endpoint_id)
    state = %{state | hosts: hosts}
    Enum.reduce(host.pairs, state, &release(&2, &1, 1001, "host disconnected"))
  end

  defp release(state, connection_id, code, reason) do
    case Map.pop(state.pairs, connection_id) do
      {nil, _} ->
        state

      {pair, pairs} ->
        if pair.timer, do: Process.cancel_timer(pair.timer)
        for pid <- [pair.client_pid, pair.host_pid], pid != nil, do: send(pid, {:relay_close, code, reason})
        refs = state.refs |> Map.delete(pair.client_ref) |> Map.delete(pair.host_ref)
        for ref <- [pair.client_ref, pair.host_ref], ref != nil, do: Process.demonitor(ref, [:flush])

        hosts =
          case Map.get(state.hosts, pair.endpoint_id) do
            %{gen: gen} = host when gen == pair.gen ->
              host = notify(host, %{type: "closed", connectionId: connection_id})
              pending = if pair.status == :pending, do: host.pending - 1, else: host.pending
              Map.put(state.hosts, pair.endpoint_id, %{host | pairs: MapSet.delete(host.pairs, connection_id), pending: pending})

            _ ->
              state.hosts
          end

        %{state | pairs: pairs, refs: refs, hosts: hosts, total: state.total - 1}
    end
  end
end
