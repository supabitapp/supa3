import XCTest
@testable import RelayTunnelCore

final class HTTPHostGuardTests: XCTestCase {
  private let authority = "127.0.0.1:40000"

  func testUpgradeRequiresAFreshBodilessConnection() throws {
    for body in ["Content-Length: 1\r\n", "Transfer-Encoding: chunked\r\n"] {
      var guardHTTP = HTTPHostGuard(authority: authority)
      let head = "GET /ws HTTP/1.1\r\nHost: \(authority)\r\nUpgrade: websocket\r\n\(body)\r\n"
      XCTAssertThrowsError(try guardHTTP.feed(Data(head.utf8)))
    }
    var guardHTTP = HTTPHostGuard(authority: authority)
    _ = try guardHTTP.feed(Data("GET /first HTTP/1.1\r\nHost: \(authority)\r\n\r\n".utf8))
    XCTAssertThrowsError(try guardHTTP.feed(Data("GET /ws HTTP/1.1\r\nHost: \(authority)\r\nUpgrade: websocket\r\n\r\n".utf8)))
  }

  func testUpgradeHeaderDoesNotAuthorizeUnconfirmedBytes() throws {
    var guardHTTP = HTTPHostGuard(authority: authority)
    let head = Data("GET /ws HTTP/1.1\r\nHost: \(authority)\r\nUpgrade: websocket\r\n\r\n".utf8)
    XCTAssertEqual(try guardHTTP.feed(head), head)
    XCTAssertEqual(try guardHTTP.feed(Data("GET /foreign HTTP/1.1\r\nHost: elsewhere.invalid\r\n\r\n".utf8)), Data())
  }

  func testFragmentedInterimResponsesReleasePayloadOnlyAfter101() throws {
    var guardHTTP = HTTPHostGuard(authority: authority)
    let head = Data("GET /ws HTTP/1.1\r\nHost: \(authority)\r\nUpgrade: websocket\r\n\r\n".utf8)
    let payload = Data([0x82, 3, 1, 2, 3])
    XCTAssertEqual(try guardHTTP.feed(head + payload), head)
    XCTAssertThrowsError(try guardHTTP.finish())
    XCTAssertTrue(guardHTTP.awaitingUpgrade)
    let interim = Data("HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 103 Early Hints\r\nLink: </style.css>\r\n\r\n".utf8)
    for byte in interim { XCTAssertEqual(try guardHTTP.observeResponse(Data([byte])), Data()) }
    var released = Data()
    for byte in Data("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n".utf8) {
      released.append(try guardHTTP.observeResponse(Data([byte])))
    }
    XCTAssertEqual(released, payload)
    XCTAssertFalse(guardHTTP.awaitingUpgrade)
    XCTAssertEqual(try guardHTTP.feed(payload), payload)
    try guardHTTP.finish()
  }

  func testRejectedUpgradeRevalidatesAnEarlyForeignRequest() throws {
    var guardHTTP = HTTPHostGuard(authority: authority)
    let head = Data("GET /ws HTTP/1.1\r\nHost: \(authority)\r\nUpgrade: websocket\r\n\r\n".utf8)
    let foreign = Data("GET /foreign HTTP/1.1\r\nHost: elsewhere.invalid\r\n\r\n".utf8)
    XCTAssertEqual(try guardHTTP.feed(head + foreign), head)
    XCTAssertThrowsError(try guardHTTP.observeResponse(Data("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n".utf8)))
  }

  func testAResponseBodyCannotResurrectARejectedUpgrade() throws {
    var guardHTTP = HTTPHostGuard(authority: authority)
    _ = try guardHTTP.feed(Data("GET /ws HTTP/1.1\r\nHost: \(authority)\r\nUpgrade: websocket\r\n\r\n".utf8))
    let fake101 = Data("HTTP/1.1 101 Switching Protocols\r\n\r\n".utf8)
    _ = try guardHTTP.observeResponse(Data("HTTP/1.1 200 OK\r\nContent-Length: \(fake101.count)\r\n\r\n".utf8) + fake101)
    XCTAssertEqual(try guardHTTP.observeResponse(fake101), Data())
    XCTAssertThrowsError(try guardHTTP.feed(Data("GET /foreign HTTP/1.1\r\nHost: elsewhere.invalid\r\n\r\n".utf8)))
  }

  func testBoundsUpgradePayloadAndCompleteResponseHeaders() throws {
    for kind in ["payload", "response"] {
      var guardHTTP = HTTPHostGuard(authority: authority)
      _ = try guardHTTP.feed(Data("GET /ws HTTP/1.1\r\nHost: \(authority)\r\nUpgrade: websocket\r\n\r\n".utf8))
      let huge = Data(repeating: 65, count: 65537)
      if kind == "payload" { XCTAssertThrowsError(try guardHTTP.feed(huge)) }
      else { XCTAssertThrowsError(try guardHTTP.observeResponse(huge + Data("\r\n\r\n".utf8))) }
    }
  }

  func testFinishRejectsTruncatedBodies() throws {
    for body in ["Content-Length: 4\r\n\r\nab", "Transfer-Encoding: chunked\r\n\r\n4\r\nab"] {
      var guardHTTP = HTTPHostGuard(authority: authority)
      _ = try guardHTTP.feed(Data("POST /upload HTTP/1.1\r\nHost: \(authority)\r\n\(body)".utf8))
      XCTAssertThrowsError(try guardHTTP.finish())
    }
  }
}
