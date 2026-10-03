defmodule Relay.Heartbeat do
  def schedule(interval_ms), do: Process.send_after(self(), :heartbeat, interval_ms)

  def tick(%{awaiting_pong: true} = state, _interval_ms), do: {:close, 1001, "heartbeat timeout", state}

  def tick(state, interval_ms) do
    schedule(interval_ms)
    {[{:ping, ""}], %{state | awaiting_pong: true}}
  end

  def pong(state), do: %{state | awaiting_pong: false}
end
