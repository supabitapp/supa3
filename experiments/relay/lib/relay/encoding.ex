defmodule Relay.Encoding do
  def encode(bin), do: Base.url_encode64(bin, padding: false)

  def decode(str, size) when is_binary(str) do
    with {:ok, bin} <- Base.url_decode64(str, padding: false),
         true <- byte_size(bin) == size and encode(bin) == str do
      {:ok, bin}
    else
      _ -> :error
    end
  end

  def decode(_, _), do: :error

  def endpoint_id(public_key), do: :crypto.hash(:sha256, public_key) |> Base.encode16(case: :lower)

  def valid_endpoint_id?(id) when is_binary(id) and byte_size(id) == 64 do
    case Base.decode16(id, case: :lower) do
      {:ok, _} -> true
      :error -> false
    end
  end

  def valid_endpoint_id?(_), do: false
end
