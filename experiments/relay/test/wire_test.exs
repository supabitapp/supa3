defmodule PassioRelay.WireTest do
  use ExUnit.Case, async: true

  alias PassioRelay.Wire

  test "base64url decoding accepts only canonical unpadded values of the right size" do
    raw = :crypto.strong_rand_bytes(32)
    encoded = Base.url_encode64(raw, padding: false)
    assert {:ok, ^raw} = Wire.decode64(encoded, 32)
    assert :error = Wire.decode64(encoded <> "=", 32)
    assert :error = Wire.decode64(Base.encode64(<<255>> <> binary_part(raw, 1, 31)), 32)
    assert :error = Wire.decode64(encoded, 31)
    assert :error = Wire.decode64(nil, 32)
    last = String.last(encoded)
    alphabet = ~c"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    index = Enum.find_index(alphabet, &(&1 == hd(String.to_charlist(last))))
    sibling = <<Enum.at(alphabet, Bitwise.bxor(index, 1))>>
    assert :error = Wire.decode64(String.slice(encoded, 0..-2//1) <> sibling, 32)
  end

  test "signatures verify over the exact challenge message" do
    {public, private} = :crypto.generate_key(:eddsa, :ed25519)
    endpoint_id = Wire.endpoint_id(public)
    assert endpoint_id =~ ~r/\A[0-9a-f]{64}\z/
    message = Wire.signed_message(endpoint_id, "nonce")
    assert message == "passio-relay-v1\n#{endpoint_id}\nnonce"
    signature = :crypto.sign(:eddsa, :none, message, [private, :ed25519])
    assert Wire.verify(public, message, signature)
    refute Wire.verify(public, message <> "\n", signature)
  end

  test "close reasons map to legal codes" do
    assert Wire.peer_close({:remote, 4001, "bye"}) == {4001, "bye"}
    assert Wire.peer_close({:remote, 1000, ""}) == {1000, ""}
    assert Wire.peer_close(:remote) == {1000, ""}
    assert Wire.peer_close({:remote, 1006, ""}) == {1000, ""}
    assert Wire.peer_close({:error, :badsize}) == {1009, "message too big"}
    assert Wire.peer_close({:error, :closed}) == {1011, "peer connection lost"}
    assert Wire.peer_close(:timeout) == {1011, "peer connection lost"}
  end
end
