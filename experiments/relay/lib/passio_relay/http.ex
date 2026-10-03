defmodule PassioRelay.Http do
  alias PassioRelay.{Hub, Metrics, Wire}

  def init(req, :healthz) do
    if Hub.draining?() do
      {:ok, Wire.json(req, 503, %{status: "draining"}), nil}
    else
      {:ok, Wire.json(req, 200, %{status: "ok"}), nil}
    end
  end

  def init(req, :metrics) do
    body =
      Map.merge(Hub.stats(), %{
        forwardedMessages: Metrics.get(:forwarded_messages),
        forwardedBytes: Metrics.get(:forwarded_bytes),
        rejectedConnections: Metrics.get(:rejected_connections),
        draining: Hub.draining?()
      })

    {:ok, Wire.json(req, 200, body), nil}
  end

  def init(req, :not_found), do: {:ok, Wire.json(req, 404, %{error: "not found"}), nil}
end
