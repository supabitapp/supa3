defmodule PassioRelay.Identity do
  def encode(bytes), do: Base.url_encode64(bytes, padding: false)

  def decode(value, size) when is_binary(value) do
    with {:ok, bytes} <- Base.url_decode64(value, padding: false),
         true <- byte_size(bytes) == size and encode(bytes) == value do
      {:ok, bytes}
    else
      _ -> :error
    end
  end

  def decode(_, _), do: :error
  def random(size), do: size |> :crypto.strong_rand_bytes() |> encode()
  def endpoint(key), do: :crypto.hash(:sha256, key) |> Base.encode16(case: :lower)
  def valid_endpoint?(value), do: is_binary(value) and Regex.match?(~r/\A[0-9a-f]{64}\z/, value)
  def signed(endpoint, nonce), do: "passio-relay-v1\n" <> endpoint <> "\n" <> nonce

  def verify(key, nonce, signature) do
    with {:ok, signature} <- decode(signature, 64) do
      :crypto.verify(:eddsa, :none, signed(endpoint(key), nonce), signature, [key, :ed25519])
    else
      _ -> false
    end
  rescue
    _ -> false
  end
end
