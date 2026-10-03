defmodule PassioRelay.Data do
  alias PassioRelay.{Config, Heartbeat, Hub, Linger, Metrics, Wire}

  @behaviour :cowboy_websocket

  @impl true
  def init(req, role) do
    with :ok <- Wire.admit(req),
         {:ok, params} <- Wire.query(req),
         {:ok, endpoint_id} <- Wire.param(params, "endpointId"),
         true <- Wire.endpoint_id?(endpoint_id) || {:reject, 400, "invalid endpointId"},
         {:ok, connection_id} <- admit(role, endpoint_id, params) do
      state = %{
        role: role,
        connection_id: connection_id,
        peer: nil,
        buffer: :queue.new(),
        out: nil,
        in: nil,
        closed: false
      }

      {:cowboy_websocket, req, state, Wire.ws_opts(Config.get().max_message_bytes)}
    else
      {:reject, status, message} -> {:ok, Wire.reject(req, status, message), :rejected}
      {:error, reason} -> {:ok, reject_admission(req, reason), :rejected}
      :error -> {:ok, Wire.reject(req, 400, "invalid query"), :rejected}
    end
  end

  defp admit(:connect, endpoint_id, _params), do: Hub.reserve(endpoint_id)

  defp admit(:accept, endpoint_id, params) do
    with {:ok, connection_id} <- Wire.param(params, "connectionId"),
         {:ok, token} <- Wire.param(params, "token"),
         :ok <- Hub.claim(endpoint_id, connection_id, token) do
      {:ok, connection_id}
    else
      :error -> {:error, :forbidden}
      error -> error
    end
  end

  defp reject_admission(req, :not_found), do: Wire.reject(req, 404, "not found")
  defp reject_admission(req, :forbidden), do: Wire.reject(req, 403, "forbidden")
  defp reject_admission(req, :draining), do: Wire.reject(req, 503, "draining")
  defp reject_admission(req, :limit), do: Wire.reject(req, 503, "connection limit reached")

  @impl true
  def websocket_init(%{role: :connect} = state) do
    case Hub.attach_client(state.connection_id, self()) do
      {:ok, c2h, h2c} -> {[], Heartbeat.start(%{state | out: c2h, in: h2c})}
      :error -> {[{:close, 1011, "pair unavailable"}], %{state | closed: true}}
    end
  end

  def websocket_init(%{role: :accept} = state) do
    case Hub.attach_host(state.connection_id, self()) do
      {:ok, client, c2h, h2c} -> {[], Heartbeat.start(%{state | peer: client, out: h2c, in: c2h})}
      :error -> {[{:close, 1011, "pair unavailable"}], %{state | closed: true}}
    end
  end

  @impl true
  def websocket_handle({type, data}, state) when type in [:text, :binary] do
    if overflow?(state.out, byte_size(data)) do
      close(state, 1013, "queue limit exceeded")
    else
      case state.peer do
        nil ->
          {[], %{state | buffer: :queue.in({type, data}, state.buffer)}}

        peer ->
          send(peer, {:relay, type, data})
          {[], state}
      end
    end
  end

  def websocket_handle(frame, state) when frame == :pong or elem(frame, 0) == :pong, do: {[], Heartbeat.pong(state)}
  def websocket_handle(_frame, state), do: {[], state}

  @impl true
  def websocket_info({:relay, type, data}, state) do
    size = byte_size(data)
    :atomics.sub(state.in, 1, size)
    :atomics.sub(state.in, 2, 1)
    Metrics.forwarded(size)
    {[{type, data}], state}
  end

  def websocket_info({:paired, host}, state) do
    for {type, data} <- :queue.to_list(state.buffer), do: send(host, {:relay, type, data})
    {[], %{state | peer: host, buffer: :queue.new()}}
  end

  def websocket_info({:relay_close, code, reason}, state), do: {[{:close, code, reason}], %{state | closed: true}}

  def websocket_info(:heartbeat, state) do
    case Heartbeat.tick(state) do
      {:ok, state} -> {[:ping], state}
      :timeout -> close(state, 1011, "heartbeat timeout")
    end
  end

  def websocket_info(_message, state), do: {[], state}

  @impl true
  def terminate(_reason, _req, :rejected), do: :ok
  def terminate(_reason, _req, %{closed: true}), do: Linger.close()

  def terminate(reason, _req, state) do
    {code, text} = Wire.peer_close(reason)
    if state.peer, do: send(state.peer, {:relay_close, code, text})
    Hub.release(state.connection_id, self(), code, text)
    Linger.close()
  end

  defp close(state, code, reason) do
    Hub.release(state.connection_id, self(), code, reason)
    {[{:close, code, reason}], %{state | closed: true}}
  end

  defp overflow?(counter, size) do
    config = Config.get()
    bytes = :atomics.add_get(counter, 1, size)
    count = :atomics.add_get(counter, 2, 1)
    bytes > config.max_queue_bytes or count > config.max_queue_messages
  end
end
