defmodule Relay.JSON do
  def encode(term), do: :json.encode(term) |> IO.iodata_to_binary()

  def decode(bin) do
    {:ok, :json.decode(bin)}
  rescue
    _ -> :error
  end
end
