defmodule Relay.Drain do
  @behaviour :gen_event

  require Logger

  @key {__MODULE__, :draining}
  @grace_ms 5_000

  def install do
    :persistent_term.put(@key, false)
    :os.set_signal(:sigterm, :handle)
    :gen_event.swap_sup_handler(:erl_signal_server, {:erl_signal_handler, []}, {__MODULE__, []})
  end

  def draining?, do: :persistent_term.get(@key, false)

  def run do
    :persistent_term.put(@key, true)
    Logger.info("drain started; waiting up to #{@grace_ms}ms for pairs to finish")
    wait_for_pairs(System.monotonic_time(:millisecond) + @grace_ms)
    Relay.Registry.close_all(1001, "relay shutting down")
    Process.sleep(200)
    Logger.info("drain complete; exiting")
    System.stop(0)
  end

  defp wait_for_pairs(deadline) do
    %{activePairs: active, pendingPairs: pending} = Relay.Registry.stats()

    if active + pending > 0 and System.monotonic_time(:millisecond) < deadline do
      Process.sleep(100)
      wait_for_pairs(deadline)
    end
  end

  @impl true
  def init(_), do: {:ok, %{}}

  @impl true
  def handle_event(:sigterm, state) do
    spawn(&run/0)
    {:ok, state}
  end

  def handle_event(_other, state), do: {:ok, state}

  @impl true
  def handle_call(_request, state), do: {:ok, :ok, state}

  @impl true
  def handle_info(_msg, state), do: {:ok, state}
end
