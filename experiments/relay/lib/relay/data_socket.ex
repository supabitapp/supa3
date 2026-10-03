defmodule Relay.DataSocket do
  @behaviour :cowboy_websocket

  alias Relay.{Heartbeat, Metrics}

  @impl true
  def init(req, state), do: {:cowboy_websocket, req, state}

  @impl true
  def websocket_init(%{role: role} = params) do
    cfg = Relay.Config.get()
    Heartbeat.schedule(cfg.heartbeat_ms)

    state = %{
      role: role,
      peer: nil,
      buffer: [],
      buffered_bytes: 0,
      buffered_count: 0,
      inflight_bytes: 0,
      inflight_count: 0,
      awaiting_pong: false,
      closing: nil,
      cfg: cfg
    }

    case admit(params) do
      {:ok, peer} -> {[], %{state | peer: peer}}
      {:error, code, reason} -> {[{:close, code, reason}], %{state | closing: {code, reason}}}
    end
  end

  defp admit(%{role: :client, endpoint_id: endpoint_id}) do
    case Relay.Registry.admit_client(endpoint_id, self()) do
      {:ok, _connection_id} -> {:ok, nil}
      {:error, :no_host} -> {:error, 1001, "no host registered"}
      {:error, _} -> {:error, 1013, "connection limit reached"}
    end
  end

  defp admit(%{role: :host, endpoint_id: endpoint_id, connection_id: connection_id, token: token}) do
    case Relay.Registry.accept(endpoint_id, connection_id, token, self()) do
      {:ok, client_pid} -> {:ok, client_pid}
      {:error, :not_found} -> {:error, 1001, "unknown connection"}
      {:error, :forbidden} -> {:error, 1008, "invalid token"}
    end
  end

  @impl true
  def websocket_handle({opcode, data}, %{cfg: cfg} = state) when opcode in [:text, :binary] do
    size = byte_size(data)

    cond do
      size > cfg.max_message_bytes ->
        close(state, 1009, "message too large")

      state.peer == nil and over_limit?(state.buffered_bytes + size, state.buffered_count + 1, cfg) ->
        close(state, 1013, "pending buffer full")

      state.peer == nil ->
        {[],
         %{
           state
           | buffer: [{opcode, data} | state.buffer],
             buffered_bytes: state.buffered_bytes + size,
             buffered_count: state.buffered_count + 1
         }}

      over_limit?(state.inflight_bytes + size, state.inflight_count + 1, cfg) ->
        close(state, 1013, "peer queue full")

      true ->
        {[], forward(state, opcode, data)}
    end
  end

  def websocket_handle(:pong, state), do: {[], Heartbeat.pong(state)}
  def websocket_handle({:pong, _}, state), do: {[], Heartbeat.pong(state)}
  def websocket_handle(_frame, state), do: {[], state}

  @impl true
  def websocket_info({:relay, from, opcode, data}, state) do
    send(from, {:relay_ack, byte_size(data)})
    Metrics.forwarded(byte_size(data))
    {[{opcode, data}], state}
  end

  def websocket_info({:relay_ack, bytes}, state) do
    {[], %{state | inflight_bytes: state.inflight_bytes - bytes, inflight_count: state.inflight_count - 1}}
  end

  def websocket_info({:paired, host_pid}, %{peer: nil} = state) do
    state = %{state | peer: host_pid}

    state =
      state.buffer
      |> Enum.reverse()
      |> Enum.reduce(state, fn {opcode, data}, acc -> forward(acc, opcode, data) end)

    {[], %{state | buffer: [], buffered_bytes: 0, buffered_count: 0}}
  end

  def websocket_info({:peer_closed, code, reason}, state),
    do: {[{:close, code, reason}], %{state | peer: nil, closing: :done}}

  def websocket_info({:relay_close, code, reason}, state), do: close(state, code, reason)

  def websocket_info(:heartbeat, state) do
    case Heartbeat.tick(state, state.cfg.heartbeat_ms) do
      {:close, code, reason, state} -> close(state, code, reason)
      other -> other
    end
  end

  def websocket_info(_msg, state), do: {[], state}

  @impl true
  def terminate(_reason, _req, %{peer: nil}), do: :ok
  def terminate(_reason, _req, %{closing: :done}), do: :ok

  def terminate(reason, _req, %{peer: peer, closing: closing}) do
    {code, text} = closing || Relay.CloseCode.from_terminate(reason)
    send(peer, {:peer_closed, code, text})
    :ok
  end

  defp forward(state, opcode, data) do
    send(state.peer, {:relay, self(), opcode, data})
    %{state | inflight_bytes: state.inflight_bytes + byte_size(data), inflight_count: state.inflight_count + 1}
  end

  defp over_limit?(bytes, count, cfg), do: bytes > cfg.max_queue_bytes or count > cfg.max_queue_messages

  defp close(state, code, reason), do: {[{:close, code, reason}], %{state | closing: {code, reason}}}
end
