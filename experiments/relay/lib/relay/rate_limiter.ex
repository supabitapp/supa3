defmodule Relay.RateLimiter do
  use GenServer

  @sweep_ms 10_000

  def start_link(opts), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  def allow?(ip), do: GenServer.call(__MODULE__, {:allow, ip})
  def size, do: GenServer.call(__MODULE__, :size)

  @impl true
  def init(_opts) do
    cfg = Relay.Config.get()
    Process.send_after(self(), :sweep, @sweep_ms)
    {:ok, %{buckets: %{}, rate: cfg.admission_rate, max_sources: cfg.admission_max_sources}}
  end

  @impl true
  def handle_call({:allow, ip}, _from, %{rate: rate} = state) do
    now = System.monotonic_time(:millisecond)
    state = if Map.has_key?(state.buckets, ip), do: state, else: make_room(state, now)
    {tokens, last} = Map.get(state.buckets, ip, {rate * 1.0, now})
    tokens = min(rate * 1.0, tokens + (now - last) * rate / 1000)

    if tokens >= 1 do
      {:reply, true, put_in(state.buckets[ip], {tokens - 1, now})}
    else
      {:reply, false, put_in(state.buckets[ip], {tokens, now})}
    end
  end

  def handle_call(:size, _from, state), do: {:reply, map_size(state.buckets), state}

  @impl true
  def handle_info(:sweep, state) do
    Process.send_after(self(), :sweep, @sweep_ms)
    {:noreply, sweep(state, System.monotonic_time(:millisecond))}
  end

  defp make_room(%{buckets: buckets, max_sources: max} = state, _now) when map_size(buckets) < max, do: state

  defp make_room(state, now) do
    state = sweep(state, now)

    if map_size(state.buckets) < state.max_sources do
      state
    else
      {stalest, _} = Enum.min_by(state.buckets, fn {_ip, {_tokens, last}} -> last end)
      %{state | buckets: Map.delete(state.buckets, stalest)}
    end
  end

  defp sweep(state, now) do
    %{state | buckets: Map.reject(state.buckets, fn {_ip, {_tokens, last}} -> now - last > @sweep_ms end)}
  end
end
