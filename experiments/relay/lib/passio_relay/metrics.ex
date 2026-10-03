defmodule PassioRelay.Metrics do
  @keys %{forwarded_messages: 1, forwarded_bytes: 2, rejected_connections: 3}

  def init, do: :persistent_term.put(__MODULE__, :counters.new(map_size(@keys), [:write_concurrency]))

  def add(key, n \\ 1), do: :counters.add(:persistent_term.get(__MODULE__), Map.fetch!(@keys, key), n)

  def get(key), do: :counters.get(:persistent_term.get(__MODULE__), Map.fetch!(@keys, key))

  def forwarded(bytes) do
    ref = :persistent_term.get(__MODULE__)
    :counters.add(ref, 1, 1)
    :counters.add(ref, 2, bytes)
  end

  def reject, do: add(:rejected_connections)
end
