defmodule Relay.MixProject do
  use Mix.Project

  def project do
    [
      app: :relay,
      version: "0.1.0",
      elixir: "~> 1.17",
      start_permanent: Mix.env() == :prod,
      deps: deps(),
      aliases: [test: "test --no-start"],
      releases: [relay: [include_executables_for: [:unix], strip_beams: true]],
      elixirc_options: [warnings_as_errors: true]
    ]
  end

  def application do
    [extra_applications: [:logger, :crypto], mod: {Relay.Application, []}]
  end

  defp deps do
    [
      {:plug_cowboy, "~> 2.7"},
      {:websock_adapter, "~> 0.5"}
    ]
  end
end
