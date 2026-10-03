defmodule PassioRelay.SignalHandler do
  @behaviour :gen_event

  def install do
    :ok = :gen_event.swap_handler(:erl_signal_server, {:erl_signal_handler, []}, {__MODULE__, []})
  end

  @impl true
  def init(_), do: {:ok, nil}

  @impl true
  def handle_event(:sigterm, state) do
    PassioRelay.Drain.start()
    {:ok, state}
  end

  def handle_event(:sigusr1, _state), do: :erlang.halt(~c"Received SIGUSR1")
  def handle_event(:sigquit, _state), do: :erlang.halt()
  def handle_event(_signal, state), do: {:ok, state}

  @impl true
  def handle_call(_request, state), do: {:ok, :ok, state}
end
