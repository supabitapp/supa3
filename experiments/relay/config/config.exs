import Config

config :logger, :default_handler, config: %{type: :standard_error}
config :logger, level: :info
config :logger, :default_formatter, format: "$time [$level] $message\n"

if config_env() == :test do
  config :logger, level: :warning
end
