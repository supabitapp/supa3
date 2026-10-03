defmodule Relay.Auth do
  @prefix "passio-relay-v1\n"

  def challenge_message(endpoint_id, nonce), do: @prefix <> endpoint_id <> "\n" <> nonce

  def verify(public_key, endpoint_id, nonce, signature)
      when byte_size(public_key) == 32 and byte_size(signature) == 64 do
    :crypto.verify(:eddsa, :none, challenge_message(endpoint_id, nonce), signature, [public_key, :ed25519])
  end

  def verify(_, _, _, _), do: false
end
