defmodule Relay.Router do
  use Plug.Router

  alias Relay.{Encoding, JSON, Metrics}

  @control_frame_bytes 4096

  plug :match
  plug :dispatch

  get "/healthz" do
    if Relay.Drain.draining?(),
      do: json(conn, 503, %{status: "draining"}),
      else: json(conn, 200, %{status: "ok"})
  end

  get "/metrics" do
    json(conn, 200, Metrics.snapshot())
  end

  get "/v1/control" do
    conn = fetch_query_params(conn)

    with :ok <- admission(conn),
         {:ok, public_key} <- Encoding.decode(conn.query_params["publicKey"], 32) |> or_reject(400, "invalid publicKey") do
      endpoint_id = Encoding.endpoint_id(public_key)
      upgrade(conn, Relay.ControlSocket, %{public_key: public_key, endpoint_id: endpoint_id}, @control_frame_bytes)
    else
      {:reject, status, message} -> reject(conn, status, message)
    end
  end

  get "/v1/connect" do
    conn = fetch_query_params(conn)
    endpoint_id = conn.query_params["endpointId"]

    with :ok <- admission(conn),
         true <- Encoding.valid_endpoint_id?(endpoint_id) |> or_reject(400, "invalid endpointId"),
         :ok <- Relay.Registry.check_admit(endpoint_id) |> admit_result() do
      upgrade(conn, Relay.DataSocket, %{role: :client, endpoint_id: endpoint_id}, Relay.Config.get().max_message_bytes)
    else
      {:reject, status, message} -> reject(conn, status, message)
    end
  end

  get "/v1/accept" do
    conn = fetch_query_params(conn)
    %{"endpointId" => endpoint_id, "connectionId" => connection_id, "token" => token} =
      Map.merge(%{"endpointId" => "", "connectionId" => "", "token" => ""}, conn.query_params)

    with :ok <- admission(conn),
         true <- Encoding.valid_endpoint_id?(endpoint_id) |> or_reject(400, "invalid endpointId"),
         {:ok, _} <- Encoding.decode(connection_id, 16) |> or_reject(404, "unknown connection"),
         {:ok, _} <- Encoding.decode(token, 32) |> or_reject(403, "invalid token"),
         :ok <- Relay.Registry.check_accept(endpoint_id, connection_id, token) |> accept_result() do
      upgrade(
        conn,
        Relay.DataSocket,
        %{role: :host, endpoint_id: endpoint_id, connection_id: connection_id, token: token},
        Relay.Config.get().max_message_bytes
      )
    else
      {:reject, status, message} -> reject(conn, status, message)
    end
  end

  match _ do
    json(conn, 404, %{error: "not found"})
  end

  defp admission(conn) do
    cond do
      Relay.Drain.draining?() -> {:reject, 503, "relay draining"}
      not Relay.RateLimiter.allow?(client_ip(conn)) -> {:reject, 429, "rate limited"}
      match?({:error, _}, WebSockAdapter.UpgradeValidation.validate_upgrade(conn)) -> {:reject, 400, "websocket upgrade required"}
      true -> :ok
    end
  end

  defp client_ip(conn) do
    forwarded = if Relay.Config.get().trust_forwarded_for, do: get_req_header(conn, "x-forwarded-for"), else: []

    with [header | _] <- forwarded,
         last when last != "" <- header |> String.split(",") |> List.last() |> String.trim(),
         {:ok, ip} <- :inet.parse_strict_address(String.to_charlist(last)) do
      ip
    else
      _ -> conn.remote_ip
    end
  end

  defp or_reject(true, _status, _message), do: true
  defp or_reject({:ok, _} = ok, _status, _message), do: ok
  defp or_reject(_, status, message), do: {:reject, status, message}

  defp admit_result(:ok), do: :ok
  defp admit_result({:error, :no_host}), do: {:reject, 404, "no host registered"}
  defp admit_result({:error, :draining}), do: {:reject, 503, "relay draining"}
  defp admit_result({:error, :limit}), do: {:reject, 503, "connection limit reached"}

  defp accept_result(:ok), do: :ok
  defp accept_result({:error, :not_found}), do: {:reject, 404, "unknown connection"}
  defp accept_result({:error, :forbidden}), do: {:reject, 403, "invalid token"}

  defp upgrade(conn, handler, state, max_frame_bytes) do
    cfg = Relay.Config.get()

    Plug.Conn.upgrade_adapter(conn, :websocket, {handler, state, %{
      compress: false,
      max_frame_size: max_frame_bytes + 14,
      idle_timeout: max(60_000, cfg.heartbeat_ms * 4)
    }})
  end

  defp reject(conn, status, message) do
    Metrics.rejected()
    json(conn, status, %{error: message})
  end

  defp json(conn, status, body) do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(status, JSON.encode(body))
  end
end
