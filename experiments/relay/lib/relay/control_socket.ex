defmodule Relay.ControlSocket do
  @behaviour :cowboy_websocket

  require Logger

  alias Relay.{Auth, Encoding, Heartbeat, JSON, Metrics}

  @impl true
  def init(req, state), do: {:cowboy_websocket, req, state}

  @impl true
  def websocket_init(%{public_key: public_key, endpoint_id: endpoint_id}) do
    cfg = Relay.Config.get()
    nonce = Encoding.encode(:crypto.strong_rand_bytes(32))
    Process.send_after(self(), :auth_timeout, cfg.auth_timeout_ms)
    Heartbeat.schedule(cfg.heartbeat_ms)

    state = %{
      public_key: public_key,
      endpoint_id: endpoint_id,
      nonce: nonce,
      registered: false,
      awaiting_pong: false,
      heartbeat_ms: cfg.heartbeat_ms
    }

    {[{:text, JSON.encode(%{type: "challenge", nonce: nonce})}], state}
  end

  @impl true
  def websocket_handle({:text, data}, %{registered: false} = state) do
    nonce = state.nonce
    state = %{state | nonce: nil}

    with {:ok, %{"type" => "authenticate", "signature" => sig}} when is_binary(nonce) <- JSON.decode(data),
         {:ok, signature} <- Encoding.decode(sig, 64),
         true <- Auth.verify(state.public_key, state.endpoint_id, nonce, signature) do
      case Relay.Registry.register(state.endpoint_id, self()) do
        {:ok, _gen} ->
          Logger.info("host registered", endpoint_id: state.endpoint_id)
          {[{:text, JSON.encode(%{type: "registered", endpointId: state.endpoint_id})}], %{state | registered: true}}

        {:error, :taken} ->
          reject(state, 1008, "endpoint already registered")

        {:error, :draining} ->
          reject(state, 1013, "relay draining")
      end
    else
      _ -> reject(state, 1008, "authentication failed")
    end
  end

  def websocket_handle(:pong, state), do: {[], Heartbeat.pong(state)}
  def websocket_handle({:pong, _}, state), do: {[], Heartbeat.pong(state)}
  def websocket_handle(:ping, state), do: {[], state}
  def websocket_handle({:ping, _}, state), do: {[], state}
  def websocket_handle(_frame, %{registered: false} = state), do: reject(state, 1008, "authentication required")
  def websocket_handle(_frame, state), do: {[], state}

  @impl true
  def websocket_info({:control, record}, state) do
    Relay.Registry.control_ack(state.endpoint_id, self())
    {[{:text, JSON.encode(record)}], state}
  end
  def websocket_info({:relay_close, code, reason}, state), do: {[{:close, code, reason}], state}

  def websocket_info(:heartbeat, state) do
    case Heartbeat.tick(state, state.heartbeat_ms) do
      {:close, code, reason, state} -> {[{:close, code, reason}], state}
      other -> other
    end
  end

  def websocket_info(:auth_timeout, %{registered: false} = state), do: reject(state, 1008, "authentication timeout")
  def websocket_info(_msg, state), do: {[], state}

  @impl true
  def terminate(_reason, _req, _state), do: :ok

  defp reject(state, code, reason) do
    Metrics.rejected()
    {[{:close, code, reason}], state}
  end
end
