defmodule PassioRelay.Heartbeat do
  alias PassioRelay.Config

  def start(state) do
    schedule()
    Map.put(state, :pong_pending, false)
  end

  def tick(%{pong_pending: true}), do: :timeout

  def tick(state) do
    schedule()
    {:ok, %{state | pong_pending: true}}
  end

  def pong(state), do: %{state | pong_pending: false}

  defp schedule, do: Process.send_after(self(), :heartbeat, Config.get().heartbeat_ms)
end
