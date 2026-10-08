import ExpoModulesCore
import UIKit
import os

struct RelayStartOptions: Record {
  @Field var relayUrl: String = ""
  @Field var hostAddress: String = ""
  @Field var port: Int?
}

public final class SupacodeRelayTunnelModule: Module {
  private var tunnels: [String: RelayTunnel] = [:]
  private let lock = NSLock()
  private var backgroundObserver: NSObjectProtocol?
  private var foregroundObserver: NSObjectProtocol?
  private let logger = Logger(subsystem: "sh.supacode.mobile", category: "relay-tunnel")

  public func definition() -> ModuleDefinition {
    Name("SupacodeRelayTunnel")
    Events("onStatus")
    OnCreate { [self] in
      self.backgroundObserver = NotificationCenter.default.addObserver(
        forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
      ) { [weak self] _ in
        guard let self else { return }
        for tunnel in self.snapshot() { tunnel.suspend() }
      }
      self.foregroundObserver = NotificationCenter.default.addObserver(
        forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main
      ) { [weak self] _ in
        guard let self else { return }
        Task { for tunnel in self.snapshot() { _ = try? await tunnel.start() } }
      }
    }
    AsyncFunction("start") { (options: RelayStartOptions) async throws -> [String: String] in
      if let port = options.port, !(0...65535).contains(port) {
        throw RelayError.invalid("Invalid loopback port")
      }
      let identity = try RelayIdentity(address: options.hostAddress)
      let tunnel = try self.getOrCreate(options: options, identity: identity)
      let origin = try await tunnel.start(port: options.port.map(UInt16.init))
      self.logger.notice("[native-relay] doorway origin=\(origin, privacy: .public) endpoint=\(identity.endpointID, privacy: .public)")
      return ["origin": origin]
    }
    AsyncFunction("stop") { (hostAddress: String?) async throws in
      let tunnels: [RelayTunnel]
      if let hostAddress {
        let identity = try RelayIdentity(address: hostAddress)
        tunnels = self.remove(identity.endpointID)
      } else { tunnels = self.removeAll() }
      for tunnel in tunnels { await tunnel.stop() }
    }
    OnDestroy {
      if let observer = self.backgroundObserver { NotificationCenter.default.removeObserver(observer) }
      if let observer = self.foregroundObserver { NotificationCenter.default.removeObserver(observer) }
      let tunnels = self.removeAll()
      Task { for tunnel in tunnels { await tunnel.stop() } }
    }
  }

  private func snapshot() -> [RelayTunnel] {
    lock.lock(); defer { lock.unlock() }; return Array(tunnels.values)
  }
  private func removeAll() -> [RelayTunnel] {
    lock.lock(); defer { lock.unlock() }
    let result = Array(tunnels.values); tunnels.removeAll(); return result
  }
  private func remove(_ key: String) -> [RelayTunnel] {
    lock.lock(); defer { lock.unlock() }
    return tunnels.removeValue(forKey: key).map { [$0] } ?? []
  }
  private func getOrCreate(options: RelayStartOptions, identity: RelayIdentity) throws -> RelayTunnel {
    lock.lock(); defer { lock.unlock() }
    if let tunnel = tunnels[identity.endpointID] { return tunnel }
    let tunnel = try RelayTunnel(relayURL: options.relayUrl, hostAddress: options.hostAddress) { [weak self] status in
      guard let self else { return }
      self.logger.debug("[native-relay] \(status.state, privacy: .public) origin=\(status.origin, privacy: .public) sessions=\(status.sessionCount) streams=\(status.activeStreams) up=\(status.bytesSent) down=\(status.bytesReceived) reason=\(status.reason ?? "", privacy: .public)")
      var event: [String: Any] = [
        "state": status.state, "hostAddress": status.hostAddress, "origin": status.origin,
        "bytesSent": status.bytesSent, "bytesReceived": status.bytesReceived,
        "activeStreams": status.activeStreams, "sessionCount": status.sessionCount
      ]
      if let reason = status.reason { event["reason"] = reason }
      self.sendEvent("onStatus", event)
    }
    tunnels[identity.endpointID] = tunnel
    return tunnel
  }
}
