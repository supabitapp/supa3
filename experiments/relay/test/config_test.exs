defmodule PassioRelay.ConfigTest do
  use ExUnit.Case, async: true

  alias PassioRelay.Config

  test "defaults bind loopback with documented limits" do
    assert {:ok, config} = Config.load(%{})
    assert config.ip == {127, 0, 0, 1}
    assert config.port == 8080
    assert config.max_message_bytes == 1_048_576
    assert config.max_queue_bytes == 4_194_304
    assert config.max_queue_messages == 256
    assert config.max_clients == 1024
    assert config.max_clients_per_host == 128
    assert config.max_pending_per_host == 32
    assert config.heartbeat_ms == 15000
    assert config.admission_rate == 100
    refute config.trust_proxy
  end

  test "port 0 and IPv6 addresses are accepted" do
    assert {:ok, %{port: 0}} = Config.load(%{"RELAY_ADDR" => "127.0.0.1:0"})
    assert {:ok, %{ip: {0, 0, 0, 0, 0, 0, 0, 1}, port: 9}} = Config.load(%{"RELAY_ADDR" => "[::1]:9"})
    assert Config.format_addr({0, 0, 0, 0, 0, 0, 0, 1}, 9) == "[::1]:9"
  end

  test "bad values are rejected with the variable name" do
    for {name, value} <- [
          {"RELAY_ADDR", "127.0.0.1"},
          {"RELAY_ADDR", "127.0.0.1:70000"},
          {"RELAY_ADDR", "999.1.1.1:80"},
          {"RELAY_MAX_MESSAGE_BYTES", "0"},
          {"RELAY_MAX_QUEUE_MESSAGES", "-1"},
          {"RELAY_HEARTBEAT_MS", "15s"},
          {"RELAY_ADMISSION_RATE", "1.5"},
          {"RELAY_TRUST_PROXY", "yes"}
        ] do
      assert {:error, message} = Config.load(%{name => value})
      assert message =~ name
    end
  end

  test "inconsistent limits are rejected" do
    assert {:error, _} = Config.load(%{"RELAY_MAX_MESSAGE_BYTES" => "10", "RELAY_MAX_QUEUE_BYTES" => "5"})
    assert {:error, _} = Config.load(%{"RELAY_MAX_CLIENTS" => "4"})
    assert {:error, _} = Config.load(%{"RELAY_MAX_PENDING_PER_HOST" => "200"})
  end
end
