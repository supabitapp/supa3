defmodule PassioRelay.Control do
  alias PassioRelay.{Config, Heartbeat, Hub, Linger, Metrics, Wire}

  @behaviour :cowboy_websocket

  @max_control_frame 16_384

  @impl true
  def init(req, _opts) do
    with :ok <- Wire.admit(req),
         {:ok, params} <- Wire.query(req),
         {:ok, encoded} <- Wire.param(params, "publicKey"),
         {:ok, public_key} <- Wire.decode64(encoded, 32) do
      state = %{public_key: public_key, endpoint_id: Wire.endpoint_id(public_key), nonce: nil, registered: false}
      {:cowboy_websocket, req, state, Wire.ws_opts(@max_control_frame)}
    else
      {:reject, status, message} -> {:ok, Wire.reject(req, status, message), :rejected}
      :error -> {:ok, Wire.reject(req, 400, "invalid publicKey"), :rejected}
    end
  end

  @impl true
  def websocket_init(state) do
    nonce = Wire.random(32)
    Process.send_after(self(), :auth_timeout, Config.get().auth_timeout_ms)
    state = Heartbeat.start(%{state | nonce: nonce})
    {[{:text, JSON.encode!(%{type: "challenge", nonce: nonce})}], state}
  end

  @impl true
  def websocket_handle({:text, data}, %{registered: false, nonce: nonce} = state) when is_binary(nonce) do
    state = %{state | nonce: nil}
    message = Wire.signed_message(state.endpoint_id, nonce)

    with {:ok, %{"type" => "authenticate", "signature" => encoded}} <- JSON.decode(data),
         {:ok, signature} <- Wire.decode64(encoded, 64),
         true <- Wire.verify(state.public_key, message, signature) do
      case Hub.register(state.endpoint_id, self()) do
        {:ok, outbox} ->
          reply = JSON.encode!(%{type: "registered", endpointId: state.endpoint_id})
          {[{:text, reply}], Map.merge(state, %{registered: true, outbox: outbox})}

        {:error, :taken} ->
          reject(state, 1008, "endpoint already registered")

        {:error, :draining} ->
          reject(state, 1001, "relay draining")
      end
    else
      _ -> reject(state, 1008, "authentication failed")
    end
  end

  def websocket_handle(frame, state) when frame == :pong or elem(frame, 0) == :pong, do: {[], Heartbeat.pong(state)}
  def websocket_handle(frame, state) when frame == :ping or elem(frame, 0) == :ping, do: {[], state}
  def websocket_handle(_frame, %{registered: true} = state), do: {[{:close, 1008, "unexpected control message"}], state}
  def websocket_handle(_frame, state), do: reject(state, 1008, "authentication failed")

  @impl true
  def websocket_info({:notify, frame}, state) do
    :atomics.sub(state.outbox, 1, byte_size(frame))
    {[{:text, frame}], state}
  end

  def websocket_info(:auth_timeout, %{registered: false} = state), do: reject(state, 1008, "authentication timeout")
  def websocket_info(:auth_timeout, state), do: {[], state}
  def websocket_info({:relay_close, code, reason}, state), do: {[{:close, code, reason}], state}

  def websocket_info(:heartbeat, state) do
    case Heartbeat.tick(state) do
      {:ok, state} -> {[:ping], state}
      :timeout -> {[{:close, 1011, "heartbeat timeout"}], state}
    end
  end

  def websocket_info(_message, state), do: {[], state}

  @impl true
  def terminate(_reason, _req, :rejected), do: :ok

  def terminate(_reason, _req, state) do
    if state.registered, do: Hub.unregister(state.endpoint_id, self())
    Linger.close()
  end

  defp reject(state, code, reason) do
    Metrics.reject()
    {[{:close, code, reason}], state}
  end
end
