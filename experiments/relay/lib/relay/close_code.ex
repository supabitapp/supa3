defmodule Relay.CloseCode do
  def from_terminate(:remote), do: {1000, ""}
  def from_terminate({:remote, code, reason}) when is_integer(code) and is_binary(reason) do
    if legal?(code), do: {code, reason}, else: {1001, "peer closed abnormally"}
  end

  def from_terminate(:normal), do: {1000, "peer closed"}
  def from_terminate(:stop), do: {1000, "peer closed"}
  def from_terminate(:shutdown), do: {1001, "relay shutting down"}
  def from_terminate(:timeout), do: {1001, "peer timed out"}
  def from_terminate({:error, :badframe}), do: {1002, "peer protocol error"}
  def from_terminate({:error, :badencoding}), do: {1007, "peer sent invalid text"}
  def from_terminate(_), do: {1001, "peer connection lost"}

  def legal?(code) when code in 1000..1003 or code in 1007..1011 or code in 3000..4999, do: true
  def legal?(_), do: false
end
