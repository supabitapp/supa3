defmodule PassioRelay.Drain do
  require Logger

  alias PassioRelay.Hub

  @grace_ms 5000
  @close_ms 1000

  def start do
    unless Hub.draining?(), do: spawn(&run/0)
    :ok
  end

  def run do
    Logger.info("passio-relay: draining")
    Hub.begin_drain()
    Hub.await_idle(@grace_ms)
    pids = Hub.close_all()
    mons = Enum.map(pids, &Process.monitor/1)
    deadline = System.monotonic_time(:millisecond) + @close_ms
    Enum.each(mons, &await_down(&1, deadline))
    Logger.info("passio-relay: drained")
    System.stop(0)
  end

  defp await_down(mon, deadline) do
    remaining = max(deadline - System.monotonic_time(:millisecond), 0)

    receive do
      {:DOWN, ^mon, :process, _, _} -> :ok
    after
      remaining -> :ok
    end
  end
end
