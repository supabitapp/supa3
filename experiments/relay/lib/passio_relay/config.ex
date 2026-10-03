defmodule PassioRelay.Config do
  @integers [
    {:max_message_bytes, "RELAY_MAX_MESSAGE_BYTES", 1_048_576},
    {:max_queue_bytes, "RELAY_MAX_QUEUE_BYTES", 4_194_304},
    {:max_queue_messages, "RELAY_MAX_QUEUE_MESSAGES", 256},
    {:max_clients, "RELAY_MAX_CLIENTS", 1024},
    {:max_clients_per_host, "RELAY_MAX_CLIENTS_PER_HOST", 128},
    {:max_pending_per_host, "RELAY_MAX_PENDING_PER_HOST", 32},
    {:auth_timeout_ms, "RELAY_AUTH_TIMEOUT_MS", 5000},
    {:pair_timeout_ms, "RELAY_PAIR_TIMEOUT_MS", 5000},
    {:write_timeout_ms, "RELAY_WRITE_TIMEOUT_MS", 5000},
    {:heartbeat_ms, "RELAY_HEARTBEAT_MS", 15000},
    {:admission_rate, "RELAY_ADMISSION_RATE", 100}
  ]

  def get, do: :persistent_term.get(__MODULE__)

  def put(config), do: :persistent_term.put(__MODULE__, config)

  def load(env \\ System.get_env()) do
    with {:ok, {ip, port}} <- parse_addr(Map.get(env, "RELAY_ADDR", "127.0.0.1:8080")),
         {:ok, values} <- parse_integers(env),
         {:ok, trust_proxy} <- parse_bool(env, "RELAY_TRUST_PROXY"),
         :ok <- check(values) do
      {:ok, Map.merge(values, %{ip: ip, port: port, trust_proxy: trust_proxy})}
    end
  end

  defp parse_integers(env) do
    Enum.reduce_while(@integers, {:ok, %{}}, fn {key, name, default}, {:ok, acc} ->
      case Map.fetch(env, name) do
        :error ->
          {:cont, {:ok, Map.put(acc, key, default)}}

        {:ok, raw} ->
          case Integer.parse(raw) do
            {value, ""} when value > 0 and value <= 1_000_000_000_000 ->
              {:cont, {:ok, Map.put(acc, key, value)}}

            _ ->
              {:halt, {:error, "#{name} must be a positive integer, got #{inspect(raw)}"}}
          end
      end
    end)
  end

  defp parse_bool(env, name) do
    case Map.get(env, name, "0") do
      v when v in ["0", "false", ""] -> {:ok, false}
      v when v in ["1", "true"] -> {:ok, true}
      v -> {:error, "#{name} must be 0, 1, true or false, got #{inspect(v)}"}
    end
  end

  defp check(values) do
    cond do
      values.max_message_bytes > values.max_queue_bytes ->
        {:error, "RELAY_MAX_MESSAGE_BYTES must not exceed RELAY_MAX_QUEUE_BYTES"}

      values.max_clients_per_host > values.max_clients ->
        {:error, "RELAY_MAX_CLIENTS_PER_HOST must not exceed RELAY_MAX_CLIENTS"}

      values.max_pending_per_host > values.max_clients_per_host ->
        {:error, "RELAY_MAX_PENDING_PER_HOST must not exceed RELAY_MAX_CLIENTS_PER_HOST"}

      true ->
        :ok
    end
  end

  def parse_addr(raw) do
    with [_, host, port] <- Regex.run(~r/^(.+):(\d{1,5})$/, raw),
         {port, ""} when port <= 65535 <- Integer.parse(port),
         {:ok, ip} <- parse_host(host) do
      {:ok, {ip, port}}
    else
      _ -> {:error, "RELAY_ADDR must be HOST:PORT with a numeric port 0-65535, got #{inspect(raw)}"}
    end
  end

  defp parse_host("[" <> rest) do
    case String.split(rest, "]") do
      [v6, ""] -> :inet.parse_ipv6strict_address(String.to_charlist(v6))
      _ -> :error
    end
  end

  defp parse_host(host) do
    case :inet.parse_ipv4strict_address(String.to_charlist(host)) do
      {:ok, ip} -> {:ok, ip}
      _ -> :inet.getaddr(String.to_charlist(host), :inet)
    end
  end

  def format_addr({_, _, _, _} = ip, port), do: "#{:inet.ntoa(ip)}:#{port}"
  def format_addr(ip, port), do: "[#{:inet.ntoa(ip)}]:#{port}"
end
