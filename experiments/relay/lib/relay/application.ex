defmodule Relay.Application do
  use Application

  @impl true
  def start(_type, _args) do
    cfg =
      case Relay.Config.load(System.get_env()) do
        {:ok, cfg} ->
          cfg

        {:error, message} ->
          IO.puts(:stderr, "relay: " <> message)
          System.halt(2)
      end

    Relay.Config.put(cfg)
    Relay.Metrics.init()
    Relay.Drain.install()

    children = [
      Relay.RateLimiter,
      Relay.Registry,
      {Plug.Cowboy, scheme: :http, plug: Relay.Router, options: cowboy_options(cfg)},
      {Task, &announce/0}
    ]

    Supervisor.start_link(children, strategy: :one_for_one, name: Relay.Supervisor)
  end

  defp cowboy_options(cfg) do
    [
      ip: cfg.ip,
      port: cfg.port,
      ref: Relay.Listener,
      transport_options: [
        max_connections: :infinity,
        socket_opts: [send_timeout: cfg.write_timeout_ms, send_timeout_close: true, nodelay: true]
      ]
    ]
  end

  defp announce do
    {ip, port} = :ranch.get_addr(Relay.Listener)
    address = Relay.Config.format_ip(ip) <> ":" <> Integer.to_string(port)
    IO.puts(Relay.JSON.encode(%{event: "listening", address: address}))
  end
end
