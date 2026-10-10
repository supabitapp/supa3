import XCTest
import CryptoKit
import Network
@testable import RelayTunnelCore

private final class FakeRelay: @unchecked Sendable {
  let signing = Curve25519.Signing.PrivateKey()
  let frames: AsyncStream<MuxFrameValue>
  private let continuation: AsyncStream<MuxFrameValue>.Continuation
  private let queue = DispatchQueue(label: "fake-relay")
  private let listener: NWListener
  private var connection: NWConnection?
  private var cipher: RelayCipher?

  var address: String {
    let hex = signing.publicKey.rawRepresentation.hex
    return "https://\(hex.prefix(32)).\(hex.suffix(32)).relay.supacode.invalid/"
  }

  init() throws {
    let parameters = NWParameters.tcp
    parameters.defaultProtocolStack.applicationProtocols.insert(NWProtocolWebSocket.Options(), at: 0)
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
    listener = try NWListener(using: parameters)
    (frames, continuation) = AsyncStream.makeStream()
  }

  func start() async throws -> String {
    try await withCheckedThrowingContinuation { ready in
      listener.stateUpdateHandler = { [weak self] state in
        guard let self else { return }
        switch state {
        case .ready:
          self.listener.stateUpdateHandler = nil
          ready.resume(returning: "ws://127.0.0.1:\(self.listener.port?.rawValue ?? 0)")
        case .failed(let error):
          self.listener.stateUpdateHandler = nil
          ready.resume(throwing: error)
        default: break
        }
      }
      listener.newConnectionHandler = { [weak self] connection in
        guard let self else { return }
        self.connection = connection
        connection.start(queue: self.queue)
        self.receive(connection)
      }
      listener.start(queue: queue)
    }
  }

  func send(_ plain: Data) {
    queue.async {
      guard let record = try? self.cipher?.seal(plain) else { return }
      self.write(record, opcode: .binary)
    }
  }

  func stop() {
    queue.async { self.connection?.cancel(); self.listener.cancel(); self.continuation.finish() }
  }

  private func receive(_ connection: NWConnection) {
    connection.receiveMessage { [weak self] data, context, _, error in
      guard let self else { return }
      let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
      guard error == nil, let data, let opcode = metadata?.opcode, opcode != .close else {
        self.continuation.finish(); return
      }
      do {
        if opcode == .text { try self.welcome(data) }
        if opcode == .binary, let cipher = self.cipher {
          for frame in try decodeFrames(cipher.open(data)) { self.continuation.yield(frame) }
        }
        self.receive(connection)
      } catch { self.continuation.finish() }
    }
  }

  private func welcome(_ hello: Data) throws {
    struct Hello: Decodable { let key: String }
    let client = try XCTUnwrap(Data(base64URL: JSONDecoder().decode(Hello.self, from: hello).key))
    let ephemeral = Curve25519.KeyAgreement.PrivateKey()
    let host = ephemeral.publicKey.rawRepresentation
    let transcript = Data("supacode-tunnel-v2\n".utf8) + signing.publicKey.rawRepresentation + client + host
    let keys = try ephemeral.sharedSecretFromKeyAgreement(with: Curve25519.KeyAgreement.PublicKey(rawRepresentation: client))
      .hkdfDerivedSymmetricKey(using: SHA256.self, salt: Data(SHA256.hash(data: transcript)),
                               sharedInfo: Data("supacode-tunnel-traffic-v1".utf8), outputByteCount: 64)
      .withUnsafeBytes { Data($0) }
    cipher = RelayCipher(sendKey: SymmetricKey(data: keys.suffix(32)), receiveKey: SymmetricKey(data: keys.prefix(32)))
    let signature = try signing.signature(for: transcript)
    write(Data("{\"type\":\"welcome\",\"version\":2,\"key\":\"\(host.base64URL)\",\"signature\":\"\(signature.base64URL)\"}".utf8),
          opcode: .text)
  }

  private func write(_ data: Data, opcode: NWProtocolWebSocket.Opcode) {
    let context = NWConnection.ContentContext(identifier: "relay", metadata: [NWProtocolWebSocket.Metadata(opcode: opcode)])
    connection?.send(content: data, contentContext: context, isComplete: true, completion: .idempotent)
  }
}

final class RelaySessionTests: XCTestCase {
  func testResumeProbesAndRetainsAResponsiveSession() async throws {
    let relay = try FakeRelay()
    defer { relay.stop() }
    let url = try await relay.start()
    let connected = expectation(description: "relay connected")
    let ping = expectation(description: "resume ping")
    let failed = expectation(description: "healthy probe should not fail")
    failed.isInverted = true
    let tunnel = try RelayTunnel(relayURL: url, hostAddress: relay.address, probeTimeout: 0.3) { status in
      if status.state == "up" { connected.fulfill() }
      if status.reason == "Relay resume probe timed out" { failed.fulfill() }
    }
    _ = try await tunnel.start(port: 0)
    _ = try await tunnel.resume()
    await fulfillment(of: [connected], timeout: 5)
    let listener = try XCTUnwrap(tunnel.listener)
    let responses = Task {
      for await frame in relay.frames where frame.type == .ping {
        relay.send(TunnelMux.frame(.pong, 0))
        ping.fulfill()
        break
      }
    }
    _ = try await tunnel.resume()
    XCTAssertTrue(tunnel.listener === listener)
    await fulfillment(of: [ping], timeout: 5)
    await fulfillment(of: [failed], timeout: 0.6)
    responses.cancel()
    await tunnel.stop()
  }

  func testResumeDropsAnUnresponsiveSessionBeforeKeepaliveExpiry() async throws {
    let relay = try FakeRelay()
    defer { relay.stop() }
    let url = try await relay.start()
    let connected = expectation(description: "relay connected")
    let failed = expectation(description: "resume probe failed")
    let tunnel = try RelayTunnel(relayURL: url, hostAddress: relay.address, probeTimeout: 0.1) { status in
      if status.state == "up" && status.sessionCount == 1 { connected.fulfill() }
      if status.reason == "Relay resume probe timed out" { failed.fulfill() }
    }
    _ = try await tunnel.start(port: 0)
    _ = try await tunnel.resume()
    await fulfillment(of: [connected], timeout: 5)
    _ = try await tunnel.resume()
    await fulfillment(of: [failed], timeout: 5)
    await tunnel.stop()
  }

  func testSessionAnswersPingsAndClosesAfterThreeIdleTicks() async throws {
    let relay = try FakeRelay()
    let watchdog = Task { try await Task.sleep(nanoseconds: 10_000_000_000); relay.stop() }
    defer { watchdog.cancel(); relay.stop() }
    let relayURL = try await relay.start()
    let (statuses, status) = AsyncStream.makeStream(of: RelayTunnelStatus.self)
    let tunnel = try RelayTunnel(relayURL: relayURL, hostAddress: relay.address, keepaliveInterval: 0.05) { status.yield($0) }
    let origin = try await tunnel.start(port: 0)
    let port = try XCTUnwrap(URL(string: origin)?.port)
    let client = NWConnection(host: "127.0.0.1", port: try XCTUnwrap(NWEndpoint.Port(rawValue: UInt16(port))), using: .tcp)
    defer { client.cancel() }
    client.start(queue: .global())
    client.send(content: Data("GET / HTTP/1.1\r\nHost: 127.0.0.1:\(port)\r\n\r\n".utf8), completion: .idempotent)

    var pong = false
    var pings = 0
    for await frame in relay.frames {
      switch frame.type {
      case .open: relay.send(TunnelMux.frame(.ping, 0))
      case .pong: pong = true
      case .ping: pings += 1
      default: break
      }
      if pings > 3 { break }
    }
    XCTAssertTrue(pong)
    XCTAssertTrue((2...3).contains(pings), "Expected the idle session to close after its third silent tick, saw \(pings) pings")
    var reason: String?
    for await update in statuses where update.state == "down" && update.reason != nil {
      reason = update.reason; break
    }
    XCTAssertEqual(reason, "Relay session timed out")
    await tunnel.stop()
  }
}
