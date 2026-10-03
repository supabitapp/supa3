defmodule PassioRelay.Config do
  @defaults [
    max_message_bytes: 1_048_576,
    max_queue_bytes: 4_194_304,
    max_queue_messages: 256,
    max_clients: 1024,
    max_clients_per_host: 128,
    max_pending_per_host: 32,
    auth_timeout_ms: 5000,
    pair_timeout_ms: 5000,
    write_timeout_ms: 5000,
    heartbeat_ms: 15_000,
    admission_rate: 100
  ]

  def load(env \\ System.get_env()) do
    config =
      Map.new(@defaults, fn {key, default} ->
        name = "RELAY_" <> String.upcase(Atom.to_string(key))
        value = Map.get(env, name, Integer.to_string(default))

        case Integer.parse(value) do
          {n, ""} when n > 0 and n <= 1_073_741_824 -> {key, n}
          _ -> raise ArgumentError, "invalid #{name}: expected integer in 1..1073741824"
        end
      end)

    Map.merge(config, address(Map.get(env, "RELAY_ADDR", "127.0.0.1:8080")))
  end

  defp address(value) do
    with [_, host, port] <- Regex.run(~r/^(\[[^\]]+\]|[^:]+):([0-9]+)$/, value),
         {port, ""} when port in 0..65535 <- Integer.parse(port),
         host = String.trim(host, "[") |> String.trim_trailing("]"),
         {:ok, ip} <- :inet.parse_address(String.to_charlist(host)) do
      %{ip: ip, port: port}
    else
      _ -> raise ArgumentError, "invalid RELAY_ADDR: expected IP:port or [IPv6]:port"
    end
  end
end
