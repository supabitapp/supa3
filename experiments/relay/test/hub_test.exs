defmodule PassioRelay.HubTest do
  use ExUnit.Case, async: false

  alias PassioRelay.{Config, Hub}

  setup do
    {:ok, config} = Config.load(%{"RELAY_MAX_MESSAGE_BYTES" => "1024", "RELAY_MAX_QUEUE_BYTES" => "1024"})
    Config.put(config)
    start_supervised!(Hub)
    :ok
  end

  defp control(drain?) do
    test = self()

    spawn_link(fn ->
      outbox = receive do: ({:outbox, outbox} -> outbox)

      loop = fn loop ->
        receive do
          {:notify, frame} ->
            if drain?, do: :atomics.sub(outbox, 1, byte_size(frame))
            send(test, {:notified, self(), JSON.decode!(frame)})
            loop.(loop)

          {:relay_close, code, reason} ->
            send(test, {:evicted, self(), code, reason})
        end
      end

      loop.(loop)
    end)
  end

  defp register(drain?) do
    pid = control(drain?)
    endpoint_id = Base.encode16(:crypto.strong_rand_bytes(32), case: :lower)
    {:ok, outbox} = Hub.register(endpoint_id, pid)
    send(pid, {:outbox, outbox})
    {endpoint_id, pid}
  end

  defp churn(endpoint_id) do
    with {:ok, connection_id} <- Hub.reserve(endpoint_id),
         {:ok, _, _} <- Hub.attach_client(connection_id, self()) do
      Hub.release(connection_id, self(), 1000, "")
      :ok
    end
  end

  test "a control reader that never drains is evicted once its notification bytes exceed the queue bound" do
    {endpoint_id, pid} = register(false)
    results = for _ <- 1..20, do: churn(endpoint_id)
    assert :error in results or {:error, :not_found} in results
    assert_receive {:evicted, ^pid, 1013, "control queue limit exceeded"}
    assert Hub.stats() == %{activeHosts: 0, activePairs: 0, pendingPairs: 0}
    assert {:error, :not_found} = Hub.reserve(endpoint_id)

    delivered =
      for _ <- 1..20, reduce: 0 do
        acc ->
          receive do
            {:notified, ^pid, _} -> acc + 1
          after
            0 -> acc
          end
      end

    assert delivered <= div(1024, 50)
  end

  test "a control reader that drains keeps its registration through the same churn" do
    {endpoint_id, pid} = register(true)
    for _ <- 1..200, do: assert(:ok = churn(endpoint_id))
    assert %{activeHosts: 1} = Hub.stats()
    refute_received {:evicted, ^pid, _, _}
    assert_receive {:notified, ^pid, %{"type" => "incoming"}}
  end

  test "eviction leaves other hosts untouched and the endpoint can register again" do
    {stalled, pid} = register(false)
    {healthy, _} = register(true)
    Enum.each(1..20, fn _ -> churn(stalled) end)
    assert_receive {:evicted, ^pid, 1013, _}
    assert :ok = churn(healthy)
    assert {:ok, _} = Hub.register(stalled, control(true))
  end
end
