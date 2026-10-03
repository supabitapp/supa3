defmodule PassioRelay.MixProject do
  use Mix.Project

  def project do
    [
      app: :passio_relay,
      version: "0.1.0",
      elixir: "~> 1.18",
      start_permanent: Mix.env() == :prod,
      deps: deps(),
      releases: [passio_relay: [include_executables_for: [:unix]]]
    ]
  end

  def application do
    [
      extra_applications: [:logger, :crypto],
      mod: {PassioRelay.Application, []}
    ]
  end

  defp deps do
    [
      {:cowboy, "~> 2.13"}
    ]
  end
end
