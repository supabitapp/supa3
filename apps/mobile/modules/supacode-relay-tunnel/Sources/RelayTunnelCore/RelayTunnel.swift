import Foundation
import Network

public struct RelayTunnelStatus {
  public let state: String
  public let hostAddress: String
  public let origin: String
  public let bytesSent: UInt64
  public let bytesReceived: UInt64
  public let activeStreams: Int
  public let sessionCount: Int
  public let reason: String?
}

private let streamWindow = 4 * 1024 * 1024
private let sessionWindow = 8 * 1024 * 1024
private let minimumCost = 48 * 1024
private let maxPlain = 64 * 1024

private final class LocalStream {
  let id: UInt32
  let connection: NWConnection
  var guardHTTP: HTTPHostGuard
  var pending = Data()
  var reading = false
  var sendCredit = streamWindow
  var receiveCredit = streamWindow
  var receiveGrant = 0
  var receiving = 0
  var localEnded = false
  var finSent = false
  var remoteEnded = false
  init(id: UInt32, connection: NWConnection, authority: String) {
    self.id = id; self.connection = connection
    guardHTTP = HTTPHostGuard(authority: authority)
  }
}

private final class ReceivedRecord {
  var remaining: Int
  let cost: Int
  init(bytes: Int) { remaining = bytes; cost = max(bytes, minimumCost) }
}

public final class RelayTunnel: @unchecked Sendable {
  public let identity: RelayIdentity
  private let relayURL: URL
  private let queue = DispatchQueue(label: "sh.supacode.relay-tunnel", qos: .userInitiated)
  private let onStatus: (RelayTunnelStatus) -> Void
  private var listener: NWListener?
  private var startingListener: NWListener?
  private var startContinuations: [CheckedContinuation<String, Error>] = []
  private var closingListener: NWListener?
  private var listenerWaiters: [() -> Void] = []
  private var port: UInt16 = 0
  private var stopped = false
  private var suspended = false
  private var streams: [UInt32: LocalStream] = [:]
  private var nextID: UInt32 = 1
  private var websocket: URLSessionWebSocketTask?
  private var urlSession: URLSession?
  private var handshake: RelayHandshake?
  private var cipher: RelayCipher?
  private var generation: UInt64 = 0
  private var handshakeTimeout: DispatchWorkItem?
  private var retry: DispatchWorkItem?
  private var retryCount = 0
  private var controls: [Data] = []
  private var sending = false
  private var pumpScheduled = false
  private var sendCredit = sessionWindow
  private var receiveCredit = sessionWindow
  private var receiveGrant = 0
  private var bytesSent: UInt64 = 0
  private var bytesReceived: UInt64 = 0
  private var sessionCount = 0
  private var state = "down"
  private var lastStatus = Date.distantPast
  private var roundRobin: UInt32 = 0

  public init(relayURL: String, hostAddress: String,
              onStatus: @escaping (RelayTunnelStatus) -> Void = { _ in }) throws {
    identity = try RelayIdentity(address: hostAddress)
    guard let url = URL(string: relayURL), ["ws", "wss"].contains(url.scheme),
          url.host != nil, url.user == nil, url.password == nil,
          url.query == nil, url.fragment == nil else { throw RelayError.invalid("Invalid relay URL") }
    self.relayURL = url; self.onStatus = onStatus
  }

  public func start(port requested: UInt16? = nil) async throws -> String {
    try await withCheckedThrowingContinuation { continuation in
      queue.async {
        guard !self.stopped else { continuation.resume(throwing: RelayError.invalid("Tunnel stopped")); return }
        self.suspended = false
        if self.listener != nil {
          continuation.resume(returning: self.origin); return
        }
        self.startContinuations.append(continuation)
        guard self.startContinuations.count == 1 else { return }
        let bind = {
          guard !self.stopped, !self.suspended else {
            self.finishStart(.failure(RelayError.invalid("Tunnel inactive"))); return
          }
          guard self.listener == nil, self.startingListener == nil, !self.startContinuations.isEmpty else { return }
          self.listen(port: requested ?? (self.port == 0 ? self.identity.stablePort : self.port),
                      fallback: self.port == 0)
        }
        if self.closingListener != nil { self.listenerWaiters.append(bind) }
        else { bind() }
      }
    }
  }

  public func stop() async {
    await withCheckedContinuation { continuation in
      queue.async {
        self.stopped = true
        self.closeListener()
        self.drop("Stopped", preserveWaiting: false)
        if self.closingListener != nil { self.listenerWaiters.append { continuation.resume() } }
        else { continuation.resume() }
      }
    }
  }

  public func suspend() {
    queue.async {
      self.suspended = true
      self.closeListener()
      self.drop("Backgrounded", preserveWaiting: false)
    }
  }

  private func closeListener() {
    finishStart(.failure(RelayError.invalid("Tunnel inactive")))
    guard let old = listener ?? startingListener else { return }
    listener = nil; startingListener = nil; closingListener = old
    old.stateUpdateHandler = { [weak self, weak old] state in
      guard let self, let old, case .cancelled = state, self.closingListener === old else { return }
      self.closingListener = nil
      let waiting = self.listenerWaiters; self.listenerWaiters.removeAll()
      for resume in waiting { resume() }
    }
    old.cancel()
  }

  private func finishStart(_ result: Result<String, Error>) {
    let waiting = startContinuations; startContinuations.removeAll()
    for continuation in waiting { continuation.resume(with: result) }
  }

  private var origin: String { "http://127.0.0.1:\(port)" }
  private func emit(_ newState: String? = nil, reason: String? = nil) {
    if let newState { state = newState }
    if newState == nil && Date().timeIntervalSince(lastStatus) < 1 { return }
    lastStatus = Date()
    onStatus(RelayTunnelStatus(state: state, hostAddress: identity.address, origin: origin,
      bytesSent: bytesSent, bytesReceived: bytesReceived, activeStreams: streams.count,
      sessionCount: sessionCount, reason: reason))
  }

  private func listen(port requested: UInt16, fallback: Bool) {
    do {
      let tcp = NWProtocolTCP.Options(); tcp.noDelay = true
      let parameters = NWParameters(tls: nil, tcp: tcp)
      parameters.allowLocalEndpointReuse = true
      parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: requested)!)
      let candidate = try NWListener(using: parameters)
      startingListener = candidate
      candidate.stateUpdateHandler = { [weak self, weak candidate] result in
        guard let self, let candidate, self.startingListener === candidate else { return }
        switch result {
        case .ready:
          self.startingListener = nil
          self.listener = candidate
          self.port = candidate.port!.rawValue
          self.emit("down")
          self.finishStart(.success(self.origin))
        case .failed(let error):
          self.startingListener = nil; candidate.cancel()
          if fallback && requested != 0 {
            self.listen(port: 0, fallback: false)
          } else { self.finishStart(.failure(error)) }
        default: break
        }
      }
      candidate.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
      candidate.start(queue: queue)
    } catch { finishStart(.failure(error)) }
  }

  private func accept(_ connection: NWConnection) {
    guard !stopped, !suspended, streams.count < 256, nextID < UInt32.max - 2 else {
      connection.cancel(); return
    }
    let stream = LocalStream(id: nextID, connection: connection, authority: "127.0.0.1:\(port)")
    nextID += 2; streams[stream.id] = stream
    connection.stateUpdateHandler = { [weak self, weak stream] result in
      guard let self, let stream, self.streams[stream.id] === stream else { return }
      switch result {
      case .ready:
        if self.cipher != nil { self.read(stream) } else { self.connect() }
      case .failed, .cancelled: self.reset(stream)
      default: break
      }
    }
    connection.start(queue: queue)
    if cipher != nil { controls.append(frame(1, stream.id)); schedulePump() }
    else { connect() }
    emit()
  }

  private func connect() {
    guard websocket == nil, !stopped, !suspended, !streams.isEmpty, retry == nil else { return }
    do {
      generation += 1
      let attempt = generation
      handshake = try RelayHandshake(identity: identity)
      var url = URLComponents(url: relayURL, resolvingAgainstBaseURL: false)!
      url.path = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/v1/connect"
      if !url.path.hasPrefix("/") { url.path = "/" + url.path }
      url.queryItems = [URLQueryItem(name: "endpointId", value: identity.endpointID)]
      let config = URLSessionConfiguration.ephemeral
      config.timeoutIntervalForRequest = 15
      config.connectionProxyDictionary = [:]
      let session = URLSession(configuration: config)
      let socket = session.webSocketTask(with: url.url!)
      socket.maximumMessageSize = maxPlain + 24
      urlSession = session; websocket = socket
      emit("connecting")
      let timeout = DispatchWorkItem { [weak self] in
        guard let self, self.generation == attempt, self.cipher == nil else { return }
        self.drop("Handshake timed out", preserveWaiting: true)
      }
      handshakeTimeout = timeout; queue.asyncAfter(deadline: .now() + 15, execute: timeout)
      socket.resume()
      socket.send(.string(handshake!.hello)) { [weak self] error in
        guard let self else { return }
        self.queue.async {
          guard self.generation == attempt else { return }
          if error != nil { self.drop("Relay send failed", preserveWaiting: true) }
          else { self.receive(attempt: attempt, socket: socket) }
        }
      }
    } catch { drop("Handshake setup failed", preserveWaiting: true) }
  }

  private func receive(attempt: UInt64, socket: URLSessionWebSocketTask) {
    socket.receive { [weak self] result in
      guard let self else { return }
      self.queue.async {
        guard self.generation == attempt else { return }
        do {
          let message = try result.get()
          if self.cipher == nil {
            guard case .string(let text) = message, let handshake = self.handshake else {
              throw RelayError.invalid("Invalid relay welcome")
            }
            self.cipher = try handshake.finish(text); self.handshake = nil
            self.handshakeTimeout?.cancel(); self.handshakeTimeout = nil
            self.retryCount = 0; self.sessionCount += 1
            for stream in self.streams.values.sorted(by: { $0.id < $1.id }) {
              self.controls.append(self.frame(1, stream.id))
              self.read(stream)
            }
            self.emit("up"); self.schedulePump()
          } else {
            guard case .data(let record) = message else { throw RelayError.invalid("Unencrypted relay message") }
            try self.receiveRecord(record)
          }
          self.receive(attempt: attempt, socket: socket)
        } catch {
          let reason = (error as? RelayError)?.description ?? "Relay disconnected"
          self.drop(reason, preserveWaiting: self.cipher == nil)
        }
      }
    }
  }

  private func drop(_ reason: String, preserveWaiting: Bool) {
    generation += 1
    retry?.cancel(); retry = nil; handshakeTimeout?.cancel(); handshakeTimeout = nil
    websocket?.cancel(with: .goingAway, reason: nil); websocket = nil
    urlSession?.invalidateAndCancel(); urlSession = nil
    cipher = nil; handshake = nil; sending = false; controls.removeAll()
    sendCredit = sessionWindow; receiveCredit = sessionWindow; receiveGrant = 0
    if !preserveWaiting {
      let old = streams; streams.removeAll()
      for stream in old.values { stream.connection.cancel() }
    }
    emit("down", reason: reason)
    if !streams.isEmpty && !stopped && !suspended {
      retryCount += 1
      let item = DispatchWorkItem { [weak self] in self?.retry = nil; self?.connect() }
      retry = item
      queue.asyncAfter(deadline: .now() + min(2, 0.25 * Double(retryCount)), execute: item)
    }
  }

  private func read(_ stream: LocalStream) {
    guard streams[stream.id] === stream, !stream.reading, !stream.localEnded,
          stream.pending.isEmpty, cipher != nil, stream.sendCredit > 0 else { return }
    stream.reading = true
    stream.connection.receive(minimumIncompleteLength: 1, maximumLength: maxPlain - 9) { [weak self, weak stream] data, _, complete, error in
      guard let self, let stream else { return }
      self.queue.async {
        guard self.streams[stream.id] === stream else { return }
        stream.reading = false
        if error != nil { self.reset(stream); return }
        do {
          if let data, !data.isEmpty {
            stream.pending.append(try stream.guardHTTP.feed(data))
          }
          if complete { stream.localEnded = true; try stream.guardHTTP.finish() }
          self.schedulePump()
          if stream.pending.isEmpty && !complete { self.read(stream) }
        } catch {
          stream.connection.send(content: Data("HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n".utf8),
                                 contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in
            self.queue.async { self.reset(stream) }
          })
        }
      }
    }
  }

  private func frame(_ type: UInt8, _ id: UInt32, _ payload: Data = Data()) -> Data {
    Data([type]) + Data(bigEndian: id) + Data(bigEndian: UInt32(payload.count)) + payload
  }
  private func window(_ id: UInt32, _ bytes: Int) -> Data { frame(3, id, Data(bigEndian: UInt32(bytes))) }
  private func schedulePump() {
    guard !pumpScheduled else { return }
    pumpScheduled = true
    queue.async { self.pumpScheduled = false; self.pump() }
  }
  private func pump() {
    guard !sending, let cipher, let socket = websocket else { return }
    var plain = Data(); var dataBytes = 0
    var finishedWrites: [LocalStream] = []
    while let control = controls.first, plain.count + control.count <= maxPlain {
      plain.append(control); controls.removeFirst()
    }
    let ready = streams.values.sorted { $0.id < $1.id }
    let ordered = ready.filter { $0.id > roundRobin } + ready.filter { $0.id <= roundRobin }
    for stream in ordered {
      let room = min(maxPlain - plain.count - 9, stream.sendCredit,
                     sendCredit >= minimumCost ? sendCredit - dataBytes : 0)
      if !stream.pending.isEmpty && room > 0 {
        let count = min(room, stream.pending.count)
        plain.append(frame(2, stream.id, Data(stream.pending.prefix(count))))
        stream.pending.removeFirst(count); stream.sendCredit -= count; dataBytes += count
        roundRobin = stream.id
        if stream.pending.isEmpty { finishedWrites.append(stream) }
      }
      if stream.pending.isEmpty && stream.localEnded && !stream.finSent && plain.count + 9 <= maxPlain {
        stream.finSent = true; plain.append(frame(4, stream.id))
      }
    }
    guard !plain.isEmpty else { return }
    if dataBytes > 0 { sendCredit -= max(dataBytes, minimumCost) }
    let attempt = generation
    do {
      let record = try cipher.seal(plain)
      sending = true; bytesSent += UInt64(dataBytes)
      socket.send(.data(record)) { [weak self] error in
        guard let self else { return }
        self.queue.async {
          guard self.generation == attempt else { return }
          self.sending = false
          if error != nil { self.drop("Relay send failed", preserveWaiting: false); return }
          for stream in finishedWrites { self.read(stream) }
          for stream in self.streams.values { self.maybeFinish(stream) }
          self.emit(); self.schedulePump()
        }
      }
    } catch { drop("Relay seal failed", preserveWaiting: false) }
  }

  private func receiveRecord(_ record: Data) throws {
    let plain = try cipher!.open(record)
    var frames: [(UInt8, UInt32, Data)] = []
    var offset = 0; var dataBytes = 0
    while offset < plain.count {
      guard offset + 9 <= plain.count else { throw RelayError.invalid("Truncated mux frame") }
      let type = plain[offset]; let id = plain.uint32(at: offset + 1)
      let length = Int(plain.uint32(at: offset + 5)); let start = offset + 9
      guard start + length <= plain.count else { throw RelayError.invalid("Truncated mux payload") }
      frames.append((type, id, Data(plain[start..<(start + length)])))
      if type == 2 { dataBytes += length }
      offset = start + length
    }
    let ticket = ReceivedRecord(bytes: dataBytes)
    if dataBytes > 0 {
      guard receiveCredit >= ticket.cost else { throw RelayError.invalid("Session receive window exceeded") }
      receiveCredit -= ticket.cost
    }
    let attempt = generation
    for (type, id, payload) in frames {
      switch type {
      case 3:
        guard payload.count == 4 else { throw RelayError.invalid("Invalid mux window") }
        let bytes = Int(payload.uint32(at: 0))
        if id == 0 {
          guard bytes > 0, sendCredit + bytes <= sessionWindow else { throw RelayError.invalid("Session window overflow") }
          sendCredit += bytes
        } else if let stream = streams[id] {
          guard bytes > 0, stream.sendCredit + bytes <= streamWindow else { throw RelayError.invalid("Stream window overflow") }
          stream.sendCredit += bytes; read(stream)
        }
        schedulePump()
      case 2:
        guard id != 0 else { throw RelayError.invalid("Invalid mux stream") }
        guard let stream = streams[id] else {
          consume(ticket, bytes: payload.count); continue
        }
        guard !stream.remoteEnded, payload.count <= stream.receiveCredit else {
          throw RelayError.invalid("Stream receive window exceeded")
        }
        do {
          let released = try stream.guardHTTP.observeResponse(payload)
          if !released.isEmpty {
            stream.pending.append(released); schedulePump()
          }
        } catch {
          consume(ticket, bytes: payload.count); reset(stream); continue
        }
        stream.receiveCredit -= payload.count; stream.receiving += 1
        bytesReceived += UInt64(payload.count)
        stream.connection.send(content: payload, completion: .contentProcessed { [weak self, weak stream] error in
          guard let self else { return }
          self.queue.async {
            guard self.generation == attempt else { return }
            self.consume(ticket, bytes: payload.count)
            guard let stream, self.streams[id] === stream else { return }
            stream.receiving -= 1
            if error != nil { self.reset(stream); return }
            stream.receiveGrant += payload.count
            if stream.receiveGrant >= streamWindow / 4 {
              self.controls.append(self.window(id, stream.receiveGrant))
              stream.receiveCredit += stream.receiveGrant; stream.receiveGrant = 0
              self.schedulePump()
            }
            self.maybeFinish(stream); self.emit()
          }
        })
      case 4:
        guard payload.isEmpty, id != 0 else { throw RelayError.invalid("Invalid mux FIN") }
        if let stream = streams[id], !stream.remoteEnded {
          if stream.guardHTTP.awaitingUpgrade { reset(stream); continue }
          stream.remoteEnded = true
          stream.receiving += 1
          stream.connection.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { [weak self, weak stream] _ in
            guard let self, let stream else { return }
            self.queue.async {
              guard self.streams[id] === stream else { return }
              stream.receiving -= 1; self.maybeFinish(stream)
            }
          })
        }
      case 5:
        guard payload.isEmpty, id != 0 else { throw RelayError.invalid("Invalid mux RST") }
        if let stream = streams.removeValue(forKey: id) { stream.connection.cancel() }
      default: throw RelayError.invalid("Unknown mux frame")
      }
    }
  }

  private func consume(_ ticket: ReceivedRecord, bytes: Int) {
    guard bytes > 0 else { return }
    ticket.remaining -= bytes
    guard ticket.remaining == 0 else { return }
    receiveGrant += ticket.cost
    if receiveGrant >= sessionWindow / 4 {
      controls.append(window(0, receiveGrant)); receiveCredit += receiveGrant; receiveGrant = 0
      schedulePump()
    }
  }
  private func reset(_ stream: LocalStream) {
    guard streams.removeValue(forKey: stream.id) != nil else { return }
    if cipher != nil { controls.append(frame(5, stream.id)); schedulePump() }
    stream.connection.cancel(); emit()
  }
  private func maybeFinish(_ stream: LocalStream) {
    if stream.finSent && stream.remoteEnded && stream.receiving == 0 && stream.pending.isEmpty {
      streams.removeValue(forKey: stream.id); stream.connection.cancel()
    }
  }
}
