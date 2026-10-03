defmodule PassioRelay.RateLimitTest do
  use ExUnit.Case, async: false

  alias PassioRelay.RateLimit

  setup do
    start_supervised!({RateLimit, rate: 5})
    :ok
  end

  test "allows a burst of twice the rate per IP then refuses" do
    results = for _ <- 1..12, do: RateLimit.allow?({10, 0, 0, 1})
    assert Enum.take(results, 10) == List.duplicate(true, 10)
    assert List.last(results) == false
    assert RateLimit.allow?({10, 0, 0, 2})
  end

  test "idle buckets are swept so bookkeeping stays bounded" do
    for i <- 1..50, do: RateLimit.allow?({10, 0, 1, i})
    assert RateLimit.size() == 50

    :sys.replace_state(RateLimit, fn state ->
      %{state | buckets: Map.new(state.buckets, fn {ip, {tokens, at}} -> {ip, {tokens, at - 10_000}} end)}
    end)

    send(RateLimit, :sweep)
    assert RateLimit.size() == 0
  end
end
