defmodule PassioRelay.Application do
  use Application

  alias PassioRelay.{Config, Metrics}

  @impl true
  def start(_type, _args) do
    config =
      case Config.load() do
        {:ok, config} ->
          config

        {:error, message} ->
          IO.puts(:stderr, "passio-relay: invalid configuration: " <> message)
          System.halt(2)
      end

    Config.put(config)
    Metrics.init()

    children = [
      PassioRelay.Hub,
      {PassioRelay.RateLimit, rate: config.admission_rate}
    ]

    {:ok, sup} = Supervisor.start_link(children, strategy: :one_for_one, name: PassioRelay.Supervisor)
    listen(config)
    PassioRelay.SignalHandler.install()
    {:ok, sup}
  end

  defp listen(config) do
    dispatch =
      :cowboy_router.compile([
        {:_,
         [
           {"/healthz", PassioRelay.Http, :healthz},
           {"/metrics", PassioRelay.Http, :metrics},
           {"/v1/control", PassioRelay.Control, nil},
           {"/v1/connect", PassioRelay.Data, :connect},
           {"/v1/accept", PassioRelay.Data, :accept},
           {:_, PassioRelay.Http, :not_found}
         ]}
      ])

    transport = %{
      socket_opts: [
        ip: config.ip,
        port: config.port,
        backlog: 4096,
        nodelay: true,
        send_timeout: config.write_timeout_ms,
        send_timeout_close: true
      ],
      max_connections: config.max_clients * 2 + 4096,
      num_acceptors: 16
    }

    protocol = %{env: %{dispatch: dispatch}, request_timeout: 10_000, idle_timeout: 30_000, max_keepalive: 100}

    case :cowboy.start_clear(:passio_relay, transport, protocol) do
      {:ok, _} ->
        {ip, port} = :ranch.get_addr(:passio_relay)
        IO.puts(JSON.encode!(%{event: "listening", address: Config.format_addr(ip, port)}))

      {:error, reason} ->
        IO.puts(
          :stderr,
          "passio-relay: cannot listen on #{Config.format_addr(config.ip, config.port)}: #{inspect(reason)}"
        )

        System.halt(1)
    end
  end
end
