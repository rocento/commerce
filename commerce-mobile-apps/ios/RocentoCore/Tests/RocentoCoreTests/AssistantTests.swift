import XCTest
@testable import RocentoCore

private actor AssistantTestTransport: HTTPTransport {
  var replies: [HTTPResult]
  var requests: [URLRequest] = []
  init(_ replies: [HTTPResult]) { self.replies = replies }
  func get(_ request: URLRequest, maxBytes: Int) async throws -> HTTPResult {
    requests.append(request)
    guard !replies.isEmpty else { throw URLError(.badServerResponse) }
    return replies.removeFirst()
  }
}
private actor AssistantCollected {
  var events: [AssistantEvent] = []
  func append(_ event: AssistantEvent) { events.append(event) }
}
final class AssistantTests: XCTestCase {
  func testPersonalizationOptOutIsHeaderNotPayload() async throws {
    let transport = AssistantTestTransport([HTTPResult(status: 200, headers: ["content-type": "text/event-stream"], body: try wire([event("done", 0)]))])
    try await client(transport).streamAssistant(AssistantInput(message: "Gift", conversationID: conversationID, requestID: requestID, personalize: false)) { _ in }
    let requests = await transport.requests
    XCTAssertEqual(requests[0].value(forHTTPHeaderField: "X-Commerce-Personalize"), "0")
    let body = try JSONSerialization.jsonObject(with: requests[0].httpBody!) as! [String: Any]; XCTAssertNil(body["personalize"])
  }
  let requestID = "80000000-0000-0000-0000-000000000001"
  let conversationID = "80000000-0000-0000-0000-000000000002"
  func fixture() throws -> [[String: Any]] {
    let data = try Data(contentsOf: Bundle.module.url(forResource: "assistant-stream", withExtension: "json")!)
    return (try JSONSerialization.jsonObject(with: data) as! [String: Any])["events"] as! [[String: Any]]
  }
  func wire(_ events: [[String: Any]], crlf: Bool = false) throws -> Data {
    let newline = crlf ? "\r\n" : "\n"
    return try events.reduce(into: Data()) { result, event in
      result.append(Data((": heartbeat" + newline + "data: ").utf8))
      result.append(try JSONSerialization.data(withJSONObject: event))
      result.append(Data((newline + newline).utf8))
    }
  }
  func event(_ type: String, _ sequence: Int, _ fields: [String: Any] = [:]) -> [String: Any] {
    ["version": "1", "request_id": requestID, "sequence": sequence, "type": type].merging(fields) { _, v in v }
  }
  func testSplitUTF8CRLFAndProductsArriveBeforeCompletion() throws {
    let bytes = try wire(fixture(), crlf: true)
    var parser = AssistantStreamDecoder(requestID: requestID)
    var events: [AssistantEvent] = []
    for byte in bytes { events += try parser.feed(Data([byte])) }
    try parser.finish()
    XCTAssertEqual(events.map(\.type), ["progress", "message.delta", "content.blocks", "done"])
    XCTAssertTrue(events[1].text!.contains("أهلاً"))
    XCTAssertEqual(events[2].blocks?.first?.products?.first?.price, "25.00")
    var split = AssistantStreamDecoder(requestID: requestID)
    let partial = try split.feed(wire(Array(fixture().dropLast())))
    XCTAssertEqual(partial.count, 3); XCTAssertFalse(split.done)
    XCTAssertThrowsError(try split.finish())
  }
  func testMismatchedRequestSequenceVersionAndMalformedUTF8AreRejected() throws {
    for fields: [String: Any] in [["request_id": conversationID], ["sequence": 9], ["version": "2"]] {
      var parser = AssistantStreamDecoder(requestID: requestID)
      let bad = event("message.delta", 0, ["text": "Hi"]).merging(fields) { _, v in v }
      XCTAssertThrowsError(try parser.feed(wire([bad])))
    }
    var parser = AssistantStreamDecoder(requestID: requestID)
    XCTAssertThrowsError(try parser.feed(Data([0xff, 10])))
    var huge = AssistantStreamDecoder(requestID: requestID)
    XCTAssertThrowsError(try huge.feed(Data(repeating: 65, count: 65_537)))
  }
  func testMalformedProductAndRepeatedBlocksAreRejected() throws {
    var events = try fixture()
    var blocks = events[2]["blocks"] as! [[String: Any]]
    var products = blocks[0]["products"] as! [[String: Any]]
    products[0]["route"] = "https://external.example/checkout"
    blocks[0]["products"] = products; events[2]["blocks"] = blocks
    var parser = AssistantStreamDecoder(requestID: requestID)
    XCTAssertThrowsError(try parser.feed(wire(events)))
    events = try Array(fixture().dropLast()); var repeated = events[2]; repeated["sequence"] = 3; events.append(repeated)
    var duplicate = AssistantStreamDecoder(requestID: requestID)
    XCTAssertThrowsError(try duplicate.feed(wire(events)))
  }
  func testCheckoutRequiresValidatedCommandAndSuccessfulDone() throws {
    let command = event("message.delta", 0, ["text": "Review checkout", "code": "open_checkout", "response_source": "R"])
    var parser = AssistantStreamDecoder(requestID: requestID), reply = AssistantReply()
    for e in try parser.feed(wire([command])) { reply.consume(e) }
    XCTAssertFalse(reply.opensCheckout)
    for e in try parser.feed(wire([event("done", 1)])) { reply.consume(e) }
    XCTAssertTrue(reply.opensCheckout)
    var failedParser = AssistantStreamDecoder(requestID: requestID), failed = AssistantReply()
    for e in try failedParser.feed(wire([command, event("error", 1, ["text": "Unavailable"]), event("done", 2)])) { failed.consume(e) }
    XCTAssertFalse(failed.opensCheckout)
    var textParser = AssistantStreamDecoder(requestID: requestID), text = AssistantReply()
    for e in try textParser.feed(wire([event("message.delta", 0, ["text": "open_checkout /checkout"]), event("done", 1)])) { text.consume(e) }
    XCTAssertFalse(text.opensCheckout)
    var invalid = AssistantStreamDecoder(requestID: requestID)
    XCTAssertThrowsError(try invalid.feed(wire([event("done", 0, ["code": "open_checkout"])])))
  }
  func testProductFollowupsStayScopedAndDoNotCaptureFreshRequests() throws {
    var parser = AssistantStreamDecoder(requestID: requestID), reply = AssistantReply()
    for event in try parser.feed(wire(fixture())) { reply.consume(event) }
    XCTAssertEqual(reply.productForFollowup("add it to my cart"), "70000000-0000-0000-0000-000000000010")
    XCTAssertEqual(reply.productForFollowup("أضفه إلى السلة"), "70000000-0000-0000-0000-000000000010")
    XCTAssertNil(reply.productForFollowup("Show oranges"))
    XCTAssertNil(reply.productForFollowup("Checkout"))
  }
  func client(_ transport: any HTTPTransport, saved: String? = nil) throws -> CommerceClient {
    CommerceClient(identity: try AppIdentity(merchantID: conversationID, environment: "production", commerceBaseURL: URL(string: "https://grocery.example.test/api")!), credentials: MemoryCredential(saved), attempts: MemoryCredential(), transport: transport)
  }
  func auth() throws -> HTTPResult {
    HTTPResult(status: 200, headers: ["set-cookie": "customer_refresh=" + String(repeating: "a", count: 64) + "; Secure"], body: try JSONSerialization.data(withJSONObject: ["customer": ["id": conversationID, "primary_identifier": "email", "email": "fixture@example.test", "verified": true], "access_token": "customer-access"]))
  }
  func testGuestAndAuthenticatedStreamingUseCommerceOriginAndDeliveryContext() async throws {
    let response = HTTPResult(status: 200, headers: ["content-type": "text/event-stream"], body: try wire(fixture()))
    let transport = AssistantTestTransport([response, try auth(), response])
    let client = try client(transport)
    let input = AssistantInput(message: "Find apples", conversationID: conversationID, requestID: requestID)
    try await client.streamAssistant(input) { _ in }
    _ = try await client.login(identifier: "fixture@example.test", password: "test")
    await client.setLocale("ar"); await client.setDelivery(try DeliveryPin(latitude: 30, longitude: 31))
    let received = AssistantCollected()
    try await client.streamAssistant(input) { await received.append($0) }
    let requests = await transport.requests
    XCTAssertNil(requests[0].value(forHTTPHeaderField: "Authorization"))
    XCTAssertEqual(requests[2].url?.absoluteString, "https://grocery.example.test/api/v1/assistant/chat")
    XCTAssertEqual(requests[2].value(forHTTPHeaderField: "Authorization"), "Bearer customer-access")
    XCTAssertNil(requests[2].value(forHTTPHeaderField: "Cookie"))
    XCTAssertEqual(requests[2].value(forHTTPHeaderField: "X-Storefront-Locale"), "ar")
    XCTAssertEqual(requests[2].value(forHTTPHeaderField: "X-Delivery-Latitude"), "30.0")
    let count = await received.events.count; XCTAssertEqual(count, 4)
  }
  func testHTTP401RefreshesButInterruptedStreamsNeverReplay() async throws {
    let response = HTTPResult(status: 200, headers: ["content-type": "text/event-stream"], body: try wire(fixture()))
    let transport = AssistantTestTransport([try auth(), HTTPResult(status: 401), try auth(), response])
    let client = try client(transport, saved: String(repeating: "a", count: 64))
    let input = AssistantInput(message: "Find apples", conversationID: conversationID, requestID: requestID)
    try await client.streamAssistant(input) { _ in }
    let requests = await transport.requests
    XCTAssertEqual(requests.map { $0.url!.lastPathComponent }, ["refresh", "chat", "refresh", "chat"])
    XCTAssertEqual(requests[1].httpBody, requests[3].httpBody)
    let broken = AssistantTestTransport([HTTPResult(status: 200, headers: ["content-type": "text/event-stream"], body: try wire(Array(fixture().dropLast())))])
    do { try await self.client(broken).streamAssistant(input) { _ in }; XCTFail("Expected interruption") } catch {}
    let count = await broken.requests.count; XCTAssertEqual(count, 1)
  }
  func testSessionChangeRejectsOldStreamAndCancellationDoesNotReplay() async throws {
    let transport = AssistantTestTransport([HTTPResult(status: 200, headers: ["content-type": "text/event-stream"], body: try wire(fixture())), HTTPResult(status: 200, body: Data("{}".utf8))])
    let client = try client(transport)
    do {
      try await client.streamAssistant(AssistantInput(message: "Find apples", conversationID: conversationID, requestID: requestID)) { event in
        if event.type == "progress" { try await client.logout() }
      }
      XCTFail("Expected session change")
    } catch {}
    let badType = AssistantTestTransport([HTTPResult(status: 200, headers: ["content-type": "application/json"], body: Data("{}".utf8))])
    do { try await self.client(badType).streamAssistant(AssistantInput(message: "Hi", conversationID: conversationID, requestID: requestID)) { _ in }; XCTFail("Expected invalid content type") } catch {}
  }
}
