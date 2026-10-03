defmodule Relay.Config do
  @key __MODULE__

  @ints [
    {:max_message_bytes, "RELAY_MAX_MESSAGE_BYTES", 1_048_576},
    {:max_queue_bytes, "RELAY_MAX_QUEUE_BYTES", 4_194_304},
    {:max_queue_messages, "RELAY_MAX_QUEUE_MESSAGES", 256},
    {:max_clients, "RELAY_MAX_CLIENTS", 1024},
    {:max_clients_per_host, "RELAY_MAX_CLIENTS_PER_HOST", 128},
    {:max_pending_per_host, "RELAY_MAX_PENDING_PER_HOST", 32},
    {:auth_timeout_ms, "RELAY_AUTH_TIMEOUT_MS", 5000},
    {:pair_timeout_ms, "RELAY_PAIR_TIMEOUT_MS", 5000},
    {:write_timeout_ms, "RELAY_WRITE_TIMEOUT_MS", 5000},
    {:heartbeat_ms, "RELAY_HEARTBEAT_MS", 15_000},
    {:admission_rate, "RELAY_ADMISSION_RATE", 100},
    {:admission_max_sources, "RELAY_ADMISSION_MAX_SOURCES", 10_000}
  ]

  def load(env) when is_map(env) do
    with {:ok, {ip, port}} <- parse_addr(Map.get(env, "RELAY_ADDR", "127.0.0.1:8080")),
         {:ok, ints} <- parse_ints(env),
         {:ok, trust} <- parse_bool(Map.get(env, "RELAY_TRUST_FORWARDED_FOR", "false")) do
      {:ok, Map.merge(ints, %{ip: ip, port: port, trust_forwarded_for: trust})}
    end
  end

  def put(cfg), do: :persistent_term.put(@key, cfg)
  def get, do: :persistent_term.get(@key)

  def format_ip({_, _, _, _} = ip), do: :inet.ntoa(ip) |> to_string()
  def format_ip(ip), do: "[" <> to_string(:inet.ntoa(ip)) <> "]"

  defp parse_ints(env) do
    Enum.reduce_while(@ints, {:ok, %{}}, fn {key, name, default}, {:ok, acc} ->
      case Map.get(env, name) do
        nil ->
          {:cont, {:ok, Map.put(acc, key, default)}}

        raw ->
          case Integer.parse(String.trim(raw)) do
            {n, ""} when n > 0 -> {:cont, {:ok, Map.put(acc, key, n)}}
            _ -> {:halt, {:error, "#{name} must be a positive integer, got #{inspect(raw)}"}}
          end
      end
    end)
  end

  defp parse_bool(raw) do
    case String.downcase(String.trim(raw)) do
      v when v in ["1", "true", "yes"] -> {:ok, true}
      v when v in ["0", "false", "no"] -> {:ok, false}
      _ -> {:error, "RELAY_TRUST_FORWARDED_FOR must be true or false, got #{inspect(raw)}"}
    end
  end

  defp parse_addr(raw) do
    with {host, port_str} <- split_addr(String.trim(raw)),
         {port, ""} when port in 0..65535 <- Integer.parse(port_str),
         {:ok, ip} <- :inet.parse_strict_address(String.to_charlist(host)) do
      {:ok, {ip, port}}
    else
      _ -> {:error, "RELAY_ADDR must be IP:PORT such as 127.0.0.1:8080 or [::1]:8080, got #{inspect(raw)}"}
    end
  end

  defp split_addr("[" <> rest) do
    case String.split(rest, "]:", parts: 2) do
      [host, port] -> {host, port}
      _ -> :error
    end
  end

  defp split_addr(raw) do
    case String.split(raw, ":") do
      [host, port] -> {host, port}
      _ -> :error
    end
  end
end
