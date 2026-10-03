package relay

import "sync/atomic"

type Metrics struct {
	ActiveHosts         atomic.Int64
	ActivePairs         atomic.Int64
	PendingPairs        atomic.Int64
	ForwardedMessages   atomic.Int64
	ForwardedBytes      atomic.Int64
	RejectedConnections atomic.Int64
}

type MetricsSnapshot struct {
	ActiveHosts         int64 `json:"activeHosts"`
	ActivePairs         int64 `json:"activePairs"`
	PendingPairs        int64 `json:"pendingPairs"`
	ForwardedMessages   int64 `json:"forwardedMessages"`
	ForwardedBytes      int64 `json:"forwardedBytes"`
	RejectedConnections int64 `json:"rejectedConnections"`
	Draining            bool  `json:"draining"`
}

func (m *Metrics) snapshot(draining bool) MetricsSnapshot {
	return MetricsSnapshot{
		ActiveHosts:         m.ActiveHosts.Load(),
		ActivePairs:         m.ActivePairs.Load(),
		PendingPairs:        m.PendingPairs.Load(),
		ForwardedMessages:   m.ForwardedMessages.Load(),
		ForwardedBytes:      m.ForwardedBytes.Load(),
		RejectedConnections: m.RejectedConnections.Load(),
		Draining:            draining,
	}
}
