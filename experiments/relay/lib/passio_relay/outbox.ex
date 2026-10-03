defmodule PassioRelay.Outbox do
  def new, do: %{queue: :queue.new(), bytes: 0, count: 0, flight: nil}

  def put(box, frame, config) do
    size = byte_size(elem(frame, 1))

    if box.bytes + size > config.max_queue_bytes or box.count + 1 > config.max_queue_messages do
      :full
    else
      {:ok,
       %{box | queue: :queue.in(frame, box.queue), bytes: box.bytes + size, count: box.count + 1}}
    end
  end

  def dispatch(%{flight: nil, count: count} = box, pid, owner, direction, timeout)
      when count > 0 and is_pid(pid) do
    {{:value, frame}, queue} = :queue.out(box.queue)
    ref = make_ref()
    timer = Process.send_after(self(), {:write_timeout, direction, ref}, timeout)
    send(pid, {:deliver, owner, direction, ref, frame})
    %{box | queue: queue, flight: {ref, timer, byte_size(elem(frame, 1))}}
  end

  def dispatch(box, _, _, _, _), do: box

  def ack(%{flight: {ref, timer, size}} = box, ref) do
    Process.cancel_timer(timer)
    {:ok, %{box | flight: nil, count: box.count - 1, bytes: box.bytes - size}, size}
  end

  def ack(_, _), do: :stale
  def expired?(%{flight: {ref, _, _}}, ref), do: true
  def expired?(_, _), do: false
end
