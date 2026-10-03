defmodule Relay.Metrics do
  @key __MODULE__
  @messages 1
  @bytes 2
  @rejected 3

  def init, do: :persistent_term.put(@key, :counters.new(3, [:write_concurrency]))

  def forwarded(bytes) do
    ref = :persistent_term.get(@key)
    :counters.add(ref, @messages, 1)
    :counters.add(ref, @bytes, bytes)
  end

  def rejected, do: :counters.add(:persistent_term.get(@key), @rejected, 1)

  def snapshot do
    ref = :persistent_term.get(@key)

    Relay.Registry.stats()
    |> Map.merge(%{
      forwardedMessages: :counters.get(ref, @messages),
      forwardedBytes: :counters.get(ref, @bytes),
      rejectedConnections: :counters.get(ref, @rejected),
      draining: Relay.Drain.draining?()
    })
  end
end
