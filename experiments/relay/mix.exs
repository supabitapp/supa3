defmodule PassioRelay.MixProject do
  use Mix.Project

  def project do
    [
      app: :passio_relay,
      version: "0.1.0",
      elixir: "~> 1.18",
      start_permanent: Mix.env() == :prod,
      deps: [{:cowboy, "~> 2.19.0"}, {:jason, "~> 1.4"}],
      releases: [passio_relay: [include_executables_for: [:unix], strip_beams: true]]
    ]
  end

  def application do
    [extra_applications: [:logger, :crypto], mod: {PassioRelay.Application, []}]
  end
end
