defmodule PassioRelayTest do
  use ExUnit.Case, async: true
  alias PassioRelay.{Config, Identity, Outbox, Socket}

  test "configuration accepts ephemeral IPv4 and IPv6 and rejects bad limits" do
    assert Config.load(%{"RELAY_ADDR" => "127.0.0.1:0"}).port == 0
    assert tuple_size(Config.load(%{"RELAY_ADDR" => "[::1]:0"}).ip) == 8

    for value <- ["0", "-1", "1.5", "abc", "12x", "1073741825"] do
      assert_raise ArgumentError, fn -> Config.load(%{"RELAY_MAX_CLIENTS" => value}) end
    end

    for value <- ["localhost:8080", "127.0.0.1:65536", "8080", "::1:80"] do
      assert_raise ArgumentError, fn -> Config.load(%{"RELAY_ADDR" => value}) end
    end
  end

  test "canonical unpadded base64 rejects alternate encodings" do
    key = :crypto.strong_rand_bytes(32)
    canonical = Identity.encode(key)
    assert {:ok, ^key} = Identity.decode(canonical, 32)
    assert :error = Identity.decode(canonical <> "=", 32)
    assert :error = Identity.decode("", 32)
    assert :error = Identity.decode(nil, 32)
  end

  test "Ed25519 proof binds the public key and socket challenge" do
    {key, private} = :crypto.generate_key(:eddsa, :ed25519)
    nonce = Identity.random(32)

    signature =
      :crypto.sign(:eddsa, :none, Identity.signed(Identity.endpoint(key), nonce), [
        private,
        :ed25519
      ])
      |> Identity.encode()

    assert Identity.verify(key, nonce, signature)
    refute Identity.verify(key, Identity.random(32), signature)
    {other, _} = :crypto.generate_key(:eddsa, :ed25519)
    refute Identity.verify(other, nonce, signature)
  end

  test "outbound accounting retains in-flight bytes until the matching acknowledgement" do
    config = %{max_queue_bytes: 3, max_queue_messages: 2}
    {:ok, box} = Outbox.put(Outbox.new(), {:binary, <<1, 2, 3>>}, config)
    box = Outbox.dispatch(box, self(), self(), :data, 1000)
    assert_receive {:deliver, _, :data, ref, {:binary, <<1, 2, 3>>}}
    assert :full = Outbox.put(box, {:binary, <<4>>}, config)
    assert :stale = Outbox.ack(box, make_ref())
    assert {:ok, %{bytes: 0, count: 0}, 3} = Outbox.ack(box, ref)
  end

  test "abnormal closes map to a legal wire code" do
    assert Socket.close_reason({:remote, 4001, "done"}) == {4001, "done"}
    assert Socket.close_reason({:remote, 1006, ""}) == {1011, "peer disconnected"}
    assert Socket.close_reason({:error, :badsize}) == {1009, "message too large"}
  end
end
