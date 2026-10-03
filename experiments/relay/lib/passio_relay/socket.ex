defmodule PassioRelay.Socket do
  alias PassioRelay.{Hub, Identity, Pair}

  def init(req, config) do
    path = :cowboy_req.path(req)

    case {:cowboy_req.method(req), path} do
      {"GET", "/healthz"} ->
        if Hub.accepting?(),
          do: json(req, 200, %{status: "ok"}),
          else: json(req, 503, %{status: "draining"})

      {"GET", "/metrics"} ->
        json(req, 200, Hub.metrics())

      {"GET", "/v1/" <> _} ->
        upgrade(req, config, path)

      _ ->
        json(req, 404, %{error: "not found"})
    end
  end

  defp upgrade(req, config, path) do
    {ip, _} = :cowboy_req.peer(req)
    params = :cowboy_req.parse_qs(req)
    params = if length(params) == map_size(Map.new(params)), do: Map.new(params), else: %{}

    case Hub.admit(path, params, ip) do
      {:ok, role} ->
        state = %{role: role, config: config, pong: nil, authenticated: false, nonce: nil}

        {:cowboy_websocket, req, state,
         %{
           idle_timeout: :infinity,
           max_frame_size:
             if(match?({:control, _, _}, role), do: 4096, else: config.max_message_bytes),
           active_n: 1,
           compress: false,
           req_filter: fn _ -> %{} end
         }}

      {:error, status} ->
        json(req, status, %{error: "admission rejected"})
    end
  end

  defp json(req, status, body) do
    req =
      :cowboy_req.reply(
        status,
        %{"content-type" => "application/json", "cache-control" => "no-store"},
        Jason.encode!(body),
        req
      )

    {:ok, req, nil}
  end

  def websocket_init(%{role: {:control, lease, _}} = state) do
    case Hub.attach(lease) do
      :ok ->
        Process.monitor(Process.whereis(Hub))
        heartbeat(state)
        nonce = Identity.random(32)
        {[{:text, Jason.encode!(%{type: "challenge", nonce: nonce})}], %{state | nonce: nonce}}

      _ ->
        close(state, 1008, "admission expired")
    end
  end

  def websocket_init(%{role: {:data, pair, side, id}} = state) do
    case Pair.attach(pair, side) do
      :ok ->
        Process.monitor(pair)
        if side == :client, do: Hub.connected(id, pair)
        heartbeat(state)
        {[], state}

      _ ->
        close(state, 1008, "pair expired")
    end
  end

  def websocket_handle({:pong, nonce}, %{pong: nonce} = state), do: {[], %{state | pong: nil}}
  def websocket_handle({type, _}, state) when type in [:pong, :ping], do: {[], state}
  def websocket_handle(type, state) when type in [:pong, :ping], do: {[], state}

  def websocket_handle(
        {:text, payload},
        %{role: {:control, lease, key}, authenticated: false} = state
      ) do
    result =
      with {:ok, %{"type" => "authenticate", "signature" => signature}} <- Jason.decode(payload),
           true <- Identity.verify(key, state.nonce, signature) do
        Hub.register(lease, Identity.endpoint(key))
      else
        _ ->
          Hub.reject()
          :invalid
      end

    if result == :ok do
      {[{:text, Jason.encode!(%{type: "registered", endpointId: Identity.endpoint(key)})}],
       %{state | authenticated: true, nonce: nil}}
    else
      close(%{state | nonce: nil}, 1008, "authentication rejected")
    end
  end

  def websocket_handle({_, _}, %{role: {:control, _, _}} = state) do
    Hub.reject()
    close(state, 1008, "unexpected control message")
  end

  def websocket_handle({type, payload}, %{role: {:data, pair, side, _}} = state)
      when type in [:text, :binary] do
    case Pair.push(pair, side, {type, payload}) do
      :ok ->
        {[], state}

      {:closed, code, reason} ->
        close(state, code, reason)

      :closed ->
        receive do
          {:close, code, reason} -> close(state, code, reason)
        after
          0 -> close(state, 1011, "pair disconnected")
        end
    end
  end

  def websocket_info({:deliver, owner, direction, ref, frame}, state) do
    send(self(), {:written, owner, direction, ref})
    {[frame], state}
  end

  def websocket_info({:written, owner, direction, ref}, state) do
    GenServer.cast(owner, {:ack, direction, ref})
    {[], state}
  end

  def websocket_info(:heartbeat, %{pong: nil} = state) do
    nonce = :crypto.strong_rand_bytes(8)
    heartbeat(state)
    {[{:ping, nonce}], %{state | pong: nonce}}
  end

  def websocket_info(:heartbeat, state), do: close(state, 1001, "heartbeat timeout")
  def websocket_info({:close, code, reason}, state), do: close(state, code, reason)

  def websocket_info({:DOWN, _, :process, _, _}, state),
    do: close(state, 1011, "pair disconnected")

  def websocket_info(_, state), do: {[], state}

  def terminate(reason, _, %{role: {:data, pair, _, _}}) do
    {code, message} = close_reason(reason)
    Pair.close(pair, code, message)
    :ok
  end

  def terminate(_, _, _), do: :ok

  def close_reason({:remote, code, reason})
      when code in [1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014] or
             code in 3000..4999,
      do: {code, reason}

  def close_reason(:remote), do: {1000, ""}
  def close_reason({:error, :badsize}), do: {1009, "message too large"}
  def close_reason(_), do: {1011, "peer disconnected"}

  defp close(%{role: {:data, pair, _, _}} = state, code, reason) do
    Pair.close(pair, code, reason)
    {[{:close, code, reason}], state}
  end

  defp close(state, code, reason), do: {[{:close, code, reason}], state}
  defp heartbeat(state), do: Process.send_after(self(), :heartbeat, state.config.heartbeat_ms)
end
