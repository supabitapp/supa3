defmodule PassioRelay.Linger do
  @linger_ms 1000

  def close do
    {:links, links} = Process.info(self(), :links)

    for port <- links, is_port(port), Port.info(port, :name) == {:name, ~c"tcp_inet"} do
      with :ok <- :gen_tcp.shutdown(port, :write),
           :ok <- :inet.setopts(port, active: false) do
        drain(port, System.monotonic_time(:millisecond) + @linger_ms)
      end
    end

    :ok
  end

  defp drain(port, deadline) do
    remaining = deadline - System.monotonic_time(:millisecond)

    with true <- remaining > 0,
         {:ok, _} <- :gen_tcp.recv(port, 0, remaining) do
      drain(port, deadline)
    end
  end
end
