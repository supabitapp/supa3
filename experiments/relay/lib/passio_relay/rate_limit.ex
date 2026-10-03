defmodule PassioRelay.RateLimit do
  use GenServer

  @max_entries 100_000
  @sweep_ms 10_000

  def start_link(opts), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  def allow?(ip), do: GenServer.call(__MODULE__, {:allow, ip})

  def size, do: GenServer.call(__MODULE__, :size)

  @impl true
  def init(opts) do
    rate = Keyword.fetch!(opts, :rate)
    Process.send_after(self(), :sweep, @sweep_ms)
    {:ok, %{rate: rate / 1000, burst: rate * 2, buckets: %{}}}
  end

  @impl true
  def handle_call({:allow, ip}, _from, state) do
    now = System.monotonic_time(:millisecond)

    case Map.fetch(state.buckets, ip) do
      :error when map_size(state.buckets) >= @max_entries ->
        {:reply, false, state}

      found ->
        tokens =
          case found do
            {:ok, {tokens, at}} -> min(state.burst, tokens + (now - at) * state.rate)
            :error -> state.burst
          end

        if tokens >= 1 do
          {:reply, true, put_in(state.buckets[ip], {tokens - 1, now})}
        else
          {:reply, false, put_in(state.buckets[ip], {tokens, now})}
        end
    end
  end

  def handle_call(:size, _from, state), do: {:reply, map_size(state.buckets), state}

  @impl true
  def handle_info(:sweep, state) do
    now = System.monotonic_time(:millisecond)

    buckets =
      Map.reject(state.buckets, fn {_, {tokens, at}} ->
        tokens + (now - at) * state.rate >= state.burst
      end)

    Process.send_after(self(), :sweep, @sweep_ms)
    {:noreply, %{state | buckets: buckets}}
  end
end
