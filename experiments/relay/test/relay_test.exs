defmodule Relay.ConfigTest do
  use ExUnit.Case, async: true

  test "defaults apply when the environment is empty" do
    assert {:ok, cfg} = Relay.Config.load(%{})
    assert cfg.ip == {127, 0, 0, 1}
    assert cfg.port == 8080
    assert cfg.max_message_bytes == 1_048_576
    assert cfg.max_queue_bytes == 4_194_304
    assert cfg.max_queue_messages == 256
    assert cfg.max_clients == 1024
    assert cfg.max_clients_per_host == 128
    assert cfg.max_pending_per_host == 32
    assert cfg.auth_timeout_ms == 5000
    assert cfg.pair_timeout_ms == 5000
    assert cfg.write_timeout_ms == 5000
    assert cfg.heartbeat_ms == 15_000
    assert cfg.admission_rate == 100
    assert cfg.admission_max_sources == 10_000
    refute cfg.trust_forwarded_for
  end

  test "addresses accept port 0 and IPv6 brackets" do
    assert {:ok, %{ip: {0, 0, 0, 0}, port: 0}} = Relay.Config.load(%{"RELAY_ADDR" => "0.0.0.0:0"})
    assert {:ok, %{ip: {0, 0, 0, 0, 0, 0, 0, 1}, port: 9000}} = Relay.Config.load(%{"RELAY_ADDR" => "[::1]:9000"})
    assert Relay.Config.format_ip({0, 0, 0, 0, 0, 0, 0, 1}) == "[::1]"
  end

  test "bad values are rejected with the variable name" do
    for {name, value} <- [
          {"RELAY_ADDR", "localhost:8080"},
          {"RELAY_ADDR", "127.0.0.1:70000"},
          {"RELAY_ADDR", "8080"},
          {"RELAY_MAX_MESSAGE_BYTES", "0"},
          {"RELAY_MAX_QUEUE_BYTES", "-1"},
          {"RELAY_HEARTBEAT_MS", "fast"},
          {"RELAY_ADMISSION_RATE", "1.5"},
          {"RELAY_TRUST_FORWARDED_FOR", "maybe"}
        ] do
      assert {:error, message} = Relay.Config.load(%{name => value})
      assert message =~ name
    end
  end
end

defmodule Relay.EncodingTest do
  use ExUnit.Case, async: true

  alias Relay.Encoding

  test "canonical unpadded base64url round-trips and rejects padding or trailing bits" do
    bin = :crypto.strong_rand_bytes(32)
    encoded = Encoding.encode(bin)
    refute String.contains?(encoded, "=")
    assert {:ok, ^bin} = Encoding.decode(encoded, 32)
    assert :error = Encoding.decode(encoded <> "=", 32)
    assert :error = Encoding.decode(Base.url_encode64(bin, padding: true), 32)
    assert :error = Encoding.decode(encoded, 31)
    assert :error = Encoding.decode(nil, 32)
    noncanonical = Encoding.encode(<<0::248, 0xFF>>) |> String.slice(0..-2//1) |> Kernel.<>("9")
    assert :error = Encoding.decode(noncanonical, 32)
  end

  test "endpoint ids are lowercase hex sha256 of the raw key" do
    key = :crypto.strong_rand_bytes(32)
    id = Encoding.endpoint_id(key)
    assert id == :crypto.hash(:sha256, key) |> Base.encode16(case: :lower)
    assert Encoding.valid_endpoint_id?(id)
    refute Encoding.valid_endpoint_id?(String.upcase(id))
    refute Encoding.valid_endpoint_id?(String.slice(id, 0, 63))
    refute Encoding.valid_endpoint_id?(nil)
  end
end

defmodule Relay.AuthTest do
  use ExUnit.Case, async: true

  alias Relay.{Auth, Encoding}

  test "verifies ed25519 signatures over the exact challenge bytes" do
    {pub, priv} = :crypto.generate_key(:eddsa, :ed25519)
    endpoint_id = Encoding.endpoint_id(pub)
    nonce = Encoding.encode(:crypto.strong_rand_bytes(32))
    message = Auth.challenge_message(endpoint_id, nonce)
    assert message == "passio-relay-v1\n" <> endpoint_id <> "\n" <> nonce
    refute String.ends_with?(message, "\n")
    sig = :crypto.sign(:eddsa, :none, message, [priv, :ed25519])
    assert Auth.verify(pub, endpoint_id, nonce, sig)
    refute Auth.verify(pub, endpoint_id, Encoding.encode(:crypto.strong_rand_bytes(32)), sig)
    refute Auth.verify(pub, endpoint_id, nonce, :crypto.sign(:eddsa, :none, message <> "\n", [priv, :ed25519]))
    {other_pub, _} = :crypto.generate_key(:eddsa, :ed25519)
    refute Auth.verify(other_pub, endpoint_id, nonce, sig)
    refute Auth.verify(pub, endpoint_id, nonce, binary_part(sig, 0, 63))
  end
end

defmodule Relay.CloseCodeTest do
  use ExUnit.Case, async: true

  test "terminate reasons map to legal close codes" do
    for reason <- [:remote, :normal, :shutdown, :timeout, {:error, :closed}, {:error, :max_frame_size_exceeded}, {:crash, :exit, :boom}] do
      {code, text} = Relay.CloseCode.from_terminate(reason)
      assert Relay.CloseCode.legal?(code), "#{inspect(reason)} mapped to #{code}"
      assert is_binary(text)
    end

    refute Relay.CloseCode.legal?(1005)
    refute Relay.CloseCode.legal?(1006)
    refute Relay.CloseCode.legal?(1015)
  end
end

defmodule Relay.RateLimiterTest do
  use ExUnit.Case

  test "token bucket allows a burst of rate tokens then refills" do
    Relay.Config.put(%{admission_rate: 3, admission_max_sources: 1000})
    start_supervised!(Relay.RateLimiter)
    ip = {10, 0, 0, 1}
    assert Enum.map(1..4, fn _ -> Relay.RateLimiter.allow?(ip) end) == [true, true, true, false]
    assert Relay.RateLimiter.allow?({10, 0, 0, 2})
    Process.sleep(400)
    assert Relay.RateLimiter.allow?(ip)
    refute Relay.RateLimiter.allow?(ip)
  end

  test "source bookkeeping is capped and evicts the least recently seen source" do
    Relay.Config.put(%{admission_rate: 2, admission_max_sources: 3})
    start_supervised!(Relay.RateLimiter)
    exhausted = {10, 0, 0, 1}
    assert Relay.RateLimiter.allow?(exhausted)
    assert Relay.RateLimiter.allow?(exhausted)
    refute Relay.RateLimiter.allow?(exhausted)
    assert Relay.RateLimiter.allow?({10, 0, 0, 2})
    assert Relay.RateLimiter.allow?({10, 0, 0, 3})
    assert Relay.RateLimiter.size() == 3
    assert Relay.RateLimiter.allow?({10, 0, 0, 4})
    assert Relay.RateLimiter.size() == 3
    assert Relay.RateLimiter.allow?(exhausted)
    assert Relay.RateLimiter.size() == 3
    assert Relay.RateLimiter.allow?({10, 0, 0, 5})
    assert Relay.RateLimiter.size() == 3
  end
end

defmodule Relay.RegistryControlQueueTest do
  use ExUnit.Case

  setup do
    {:ok, cfg} = Relay.Config.load(%{"RELAY_MAX_QUEUE_MESSAGES" => "3", "RELAY_PAIR_TIMEOUT_MS" => "60000"})
    Relay.Config.put(cfg)
    :persistent_term.put({Relay.Drain, :draining}, false)
    Relay.Metrics.init()
    start_supervised!(Relay.Registry)
    :ok
  end

  defp idle, do: spawn(fn -> receive do: (:stop -> :ok) end)

  test "control notifications are bounded: admissions stop at the cap and a stalled host is killed" do
    host = idle()
    ref = Process.monitor(host)
    assert {:ok, _gen} = Relay.Registry.register("ep", host)
    clients = for _ <- 1..3, do: idle()
    for client <- clients, do: assert({:ok, _} = Relay.Registry.admit_client("ep", client))
    assert {:error, :limit} = Relay.Registry.admit_client("ep", idle())
    assert Process.alive?(host)

    Relay.Registry.control_ack("ep", host)
    assert {:ok, _} = Relay.Registry.admit_client("ep", idle())
    assert {:error, :limit} = Relay.Registry.admit_client("ep", idle())

    Process.exit(hd(clients), :kill)
    assert_receive {:DOWN, ^ref, :process, ^host, {:shutdown, :control_queue_full}}, 1000
    assert %{activeHosts: 0, pendingPairs: 0, activePairs: 0} = Relay.Registry.stats()
  end

  test "acks from a stale host pid are ignored" do
    host = idle()
    assert {:ok, _} = Relay.Registry.register("ep", host)
    for _ <- 1..3, do: assert({:ok, _} = Relay.Registry.admit_client("ep", idle()))
    Relay.Registry.control_ack("ep", idle())
    assert {:error, :limit} = Relay.Registry.admit_client("ep", idle())
  end
end
