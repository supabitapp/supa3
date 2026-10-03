import Config

config :logger, :default_handler, config: [type: :standard_error]
config :logger, :default_formatter, format: "$time [$level] $message $metadata\n", metadata: [:endpoint_id, :connection_id]
config :logger, level: :info
