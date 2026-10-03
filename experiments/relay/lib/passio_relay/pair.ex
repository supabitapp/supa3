defmodule PassioRelay.Pair do
  use GenServer, restart: :temporary
  alias PassioRelay.{Hub, Outbox}

  def start_link(args), do: GenServer.start_link(__MODULE__, args)
  def attach(pid, side), do: call(pid, {:attach, side, self()})
  def push(pid, side, frame), do: call(pid, {:push, side, self(), frame})
  def close(pid, code, reason), do: GenServer.cast(pid, {:close, code, reason})

  defp call(pid, request) do
    GenServer.call(pid, request)
  catch
    :exit, _ -> :closed
  end

  @impl true
  def init({config, deadline}) do
    timer =
      Process.send_after(
        self(),
        :pair_timeout,
        max(0, deadline - System.monotonic_time(:millisecond))
      )

    {:ok,
     %{
       deadline: deadline,
       config: config,
       client: nil,
       host: nil,
       timer: timer,
       client_box: Outbox.new(),
       host_box: Outbox.new(),
       paired: false
     }}
  end

  @impl true
  def handle_call({:attach, side, pid}, _, state) do
    cond do
      not state.paired and System.monotonic_time(:millisecond) >= state.deadline ->
        stop_reply(state, 1008, "pair timeout")

      Map.fetch!(state, side) == nil ->
        Process.monitor(pid)
        state = Map.put(state, side, pid)

        state =
          if is_pid(state.client) and is_pid(state.host) do
            Process.cancel_timer(state.timer)
            %{state | paired: true}
          else
            state
          end

        {:reply, :ok, dispatch(state)}

      true ->
        {:reply, :closed, state}
    end
  end

  def handle_call({:push, side, pid, frame}, _, state) do
    target = if side == :client, do: :host_box, else: :client_box

    cond do
      Map.fetch!(state, side) != pid ->
        {:reply, :closed, state}

      byte_size(elem(frame, 1)) > state.config.max_message_bytes ->
        stop_reply(state, 1009, "message too large")

      true ->
        case Outbox.put(Map.fetch!(state, target), frame, state.config) do
          {:ok, box} -> {:reply, :ok, dispatch(Map.put(state, target, box))}
          :full -> stop_reply(state, 1013, "queue limit")
        end
    end
  end

  @impl true
  def handle_cast({:ack, direction, ref}, state) do
    case Outbox.ack(Map.fetch!(state, direction), ref) do
      {:ok, box, size} ->
        Hub.forwarded(size)
        {:noreply, dispatch(Map.put(state, direction, box))}

      :stale ->
        {:noreply, state}
    end
  end

  def handle_cast({:close, code, reason}, state), do: stop(state, code, reason)

  @impl true
  def handle_info(:pair_timeout, %{paired: false} = state), do: stop(state, 1008, "pair timeout")
  def handle_info(:pair_timeout, state), do: {:noreply, state}

  def handle_info({:write_timeout, direction, ref}, state) do
    if Outbox.expired?(Map.fetch!(state, direction), ref) do
      stop(state, 1013, "write timeout")
    else
      {:noreply, state}
    end
  end

  def handle_info({:DOWN, _, :process, _, _}, state), do: stop(state, 1011, "peer disconnected")

  defp dispatch(%{paired: false} = state), do: state

  defp dispatch(state) do
    %{
      state
      | client_box:
          Outbox.dispatch(
            state.client_box,
            state.client,
            self(),
            :client_box,
            state.config.write_timeout_ms
          ),
        host_box:
          Outbox.dispatch(
            state.host_box,
            state.host,
            self(),
            :host_box,
            state.config.write_timeout_ms
          )
    }
  end

  defp stop_reply(state, code, reason) do
    notify(state, code, reason)
    {:stop, :normal, {:closed, code, reason}, state}
  end

  defp stop(state, code, reason) do
    notify(state, code, reason)
    {:stop, :normal, state}
  end

  defp notify(state, code, reason) do
    for pid <- [state.client, state.host], is_pid(pid), do: send(pid, {:close, code, reason})
  end
end
