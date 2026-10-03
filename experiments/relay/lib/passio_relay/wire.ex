defmodule PassioRelay.Wire do
  alias PassioRelay.{Config, Hub, Metrics, RateLimit}

  def random(bytes), do: Base.url_encode64(:crypto.strong_rand_bytes(bytes), padding: false)

  def decode64(value, size) when is_binary(value) do
    with {:ok, raw} when byte_size(raw) == size <- Base.url_decode64(value, padding: false),
         ^value <- Base.url_encode64(raw, padding: false) do
      {:ok, raw}
    else
      _ -> :error
    end
  end

  def decode64(_, _), do: :error

  def endpoint_id(public_key), do: Base.encode16(:crypto.hash(:sha256, public_key), case: :lower)

  def signed_message(endpoint_id, nonce), do: "passio-relay-v1\n" <> endpoint_id <> "\n" <> nonce

  def verify(public_key, message, signature),
    do: :crypto.verify(:eddsa, :none, message, signature, [public_key, :ed25519])

  def endpoint_id?(value), do: is_binary(value) and value =~ ~r/\A[0-9a-f]{64}\z/

  def peer_close({:remote, code, reason})
      when code in 1000..1003 or code in 1007..1014 or code in 3000..4999,
      do: {code, reason}

  def peer_close(:remote), do: {1000, ""}
  def peer_close({:remote, _, _}), do: {1000, ""}
  def peer_close({:error, :badsize}), do: {1009, "message too big"}
  def peer_close(_), do: {1011, "peer connection lost"}

  def query(req) do
    {:ok, :cowboy_req.parse_qs(req)}
  rescue
    _ -> :error
  end

  def param(params, key) do
    case for {^key, value} <- params, do: value do
      [value] when is_binary(value) -> {:ok, value}
      _ -> :error
    end
  end

  def admit(req) do
    cond do
      :cowboy_req.method(req) != "GET" or
          String.downcase(:cowboy_req.header("upgrade", req, "")) != "websocket" ->
        {:reject, 426, "websocket upgrade required"}

      Hub.draining?() ->
        {:reject, 503, "draining"}

      not RateLimit.allow?(client_ip(req)) ->
        {:reject, 429, "rate limited"}

      true ->
        :ok
    end
  end

  def reject(req, status, message) do
    Metrics.reject()
    json(req, status, %{error: message})
  end

  def json(req, status, body) do
    :cowboy_req.reply(
      status,
      %{"content-type" => "application/json", "cache-control" => "no-store"},
      JSON.encode!(body),
      req
    )
  end

  def ws_opts(max_frame_size) do
    %{max_frame_size: max_frame_size, idle_timeout: :infinity, compress: false, active_n: 16}
  end

  defp client_ip(req) do
    {ip, _} = :cowboy_req.peer(req)

    with true <- Config.get().trust_proxy,
         header when is_binary(header) <- :cowboy_req.header("x-forwarded-for", req),
         last = header |> String.split(",") |> List.last() |> String.trim(),
         {:ok, forwarded} <- :inet.parse_strict_address(String.to_charlist(last)) do
      forwarded
    else
      _ -> ip
    end
  end
end
