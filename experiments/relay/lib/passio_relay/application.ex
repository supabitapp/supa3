defmodule PassioRelay.Application do
  use Application

  @impl true
  def start(_, _) do
    :logger.add_primary_filter(:relay_redaction, {&PassioRelay.Log.filter/2, nil})

    if Application.get_env(:passio_relay, :start_listener, true) do
      config = PassioRelay.Config.load()

      {:ok, supervisor} =
        Supervisor.start_link(
          [
            {DynamicSupervisor, name: PassioRelay.Pairs, strategy: :one_for_one},
            {PassioRelay.Hub, config}
          ],
          strategy: :one_for_all,
          name: PassioRelay.Supervisor
        )

      dispatch = :cowboy_router.compile([{:_, [{:_, PassioRelay.Socket, config}]}])

      {:ok, _} =
        :cowboy.start_clear(
          :passio_relay,
          %{
            num_acceptors: 4,
            num_conns_sups: 1,
            max_connections: config.max_clients * 3 + 32,
            shutdown: 100,
            socket_opts: [
              ip: config.ip,
              port: config.port,
              nodelay: true,
              sndbuf: 16_384,
              recbuf: 16_384,
              buffer: 16_384,
              high_watermark: 16_384,
              low_watermark: 8192,
              send_timeout: config.write_timeout_ms,
              send_timeout_close: true
            ]
          },
          %{
            env: %{dispatch: dispatch},
            protocols: [:http],
            active_n: 1,
            max_request_line_length: 2048,
            request_timeout: config.auth_timeout_ms,
            idle_timeout: config.auth_timeout_ms
          }
        )

      :ok =
        :gen_event.swap_handler(
          :erl_signal_server,
          {:erl_signal_handler, []},
          {PassioRelay.Signal, []}
        )

      port = :ranch.get_port(:passio_relay)
      ip = config.ip |> :inet.ntoa() |> to_string()
      address = if tuple_size(config.ip) == 8, do: "[#{ip}]:#{port}", else: "#{ip}:#{port}"
      IO.puts(Jason.encode!(%{event: "listening", address: address}))
      {:ok, supervisor}
    else
      Supervisor.start_link([], strategy: :one_for_one)
    end
  rescue
    error in ArgumentError ->
      IO.puts(:stderr, Exception.message(error))
      {:error, :invalid_configuration}
  end

  @impl true
  def stop(_), do: :cowboy.stop_listener(:passio_relay)
end

defmodule PassioRelay.Signal do
  @behaviour :gen_event
  def init(_), do: {:ok, nil}

  def handle_event(:sigterm, state) do
    send(PassioRelay.Hub, :drain)
    {:ok, state}
  end

  def handle_event(_, state), do: {:ok, state}
  def handle_call(_, state), do: {:ok, :ok, state}
  def handle_info(_, state), do: {:ok, state}
  def terminate(_, _), do: :ok
  def code_change(_, state, _), do: {:ok, state}
end

defmodule PassioRelay.Log do
  def filter(event, _), do: %{event | msg: {:string, ~c"relay runtime event"}, meta: %{}}
end
