import Foundation

struct HTTPHostGuard {
  enum Phase { case headers, body(Int), chunkSize, chunk(Int), chunkCRLF, trailers, opaque }
  let authority: String
  var phase: Phase = .headers
  var buffered = Data()
  private let delimiter = Data("\r\n\r\n".utf8)
  mutating func feed(_ bytes: Data) throws -> Data {
    buffered.append(bytes)
    var output = Data()
    while !buffered.isEmpty {
      switch phase {
      case .opaque:
        output.append(buffered); buffered.removeAll(keepingCapacity: true)
      case .headers:
        guard let end = buffered.range(of: delimiter) else {
          if buffered.count > 16384 { throw RelayError.invalid("HTTP headers too large") }
          return output
        }
        let count = end.upperBound - buffered.startIndex
        guard count <= 16384, let text = String(data: buffered.prefix(count), encoding: .isoLatin1) else {
          throw RelayError.invalid("Invalid HTTP headers")
        }
        let lines = text.components(separatedBy: "\r\n")
        guard let first = lines.first, first.split(separator: " ").count == 3,
              !first.contains("://") else { throw RelayError.invalid("Invalid HTTP request target") }
        var headers: [String: [String]] = [:]
        for line in lines.dropFirst() where !line.isEmpty {
          guard !line.hasPrefix(" "), !line.hasPrefix("\t"), let colon = line.firstIndex(of: ":") else {
            throw RelayError.invalid("Invalid HTTP header")
          }
          let name = line[..<colon].lowercased()
          headers[name, default: []].append(line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces))
        }
        guard headers["host"] == [authority] else { throw RelayError.invalid("Misdirected HTTP Host") }
        let lengths = headers["content-length"] ?? []
        let transfer = headers["transfer-encoding"] ?? []
        guard lengths.count <= 1, transfer.count <= 1, lengths.isEmpty || transfer.isEmpty else {
          throw RelayError.invalid("Ambiguous HTTP body")
        }
        if headers["upgrade"] != nil {
          phase = .opaque
        } else if !transfer.isEmpty {
          guard transfer[0].lowercased() == "chunked" else { throw RelayError.invalid("Unsupported HTTP body") }
          phase = .chunkSize
        } else if let length = lengths.first {
          guard let size = Int(length), size >= 0 else { throw RelayError.invalid("Invalid HTTP length") }
          phase = size == 0 ? .headers : .body(size)
        }
        output.append(buffered.prefix(count)); buffered.removeFirst(count)
      case .body(let remaining), .chunk(let remaining):
        let count = min(remaining, buffered.count)
        output.append(buffered.prefix(count)); buffered.removeFirst(count)
        if case .body = phase { phase = count == remaining ? .headers : .body(remaining - count) }
        else { phase = count == remaining ? .chunkCRLF : .chunk(remaining - count) }
      case .chunkSize:
        guard let end = buffered.range(of: Data("\r\n".utf8)) else {
          if buffered.count > 1024 { throw RelayError.invalid("Invalid HTTP chunk") }; return output
        }
        let count = end.upperBound - buffered.startIndex
        let line = String(decoding: buffered.prefix(count - 2), as: UTF8.self).components(separatedBy: ";")[0]
        guard let size = Int(line, radix: 16), size >= 0 else { throw RelayError.invalid("Invalid HTTP chunk") }
        output.append(buffered.prefix(count)); buffered.removeFirst(count)
        phase = size == 0 ? .trailers : .chunk(size)
      case .chunkCRLF:
        guard buffered.count >= 2 else { return output }
        guard buffered.prefix(2) == Data("\r\n".utf8) else { throw RelayError.invalid("Invalid HTTP chunk ending") }
        output.append(buffered.prefix(2)); buffered.removeFirst(2); phase = .chunkSize
      case .trailers:
        if buffered.starts(with: Data("\r\n".utf8)) {
          output.append(buffered.prefix(2)); buffered.removeFirst(2); phase = .headers
        } else if let end = buffered.range(of: delimiter) {
          let count = end.upperBound - buffered.startIndex
          guard count <= 16384 else { throw RelayError.invalid("HTTP trailers too large") }
          output.append(buffered.prefix(count)); buffered.removeFirst(count); phase = .headers
        } else {
          if buffered.count > 16384 { throw RelayError.invalid("HTTP trailers too large") }; return output
        }
      }
    }
    return output
  }
}
