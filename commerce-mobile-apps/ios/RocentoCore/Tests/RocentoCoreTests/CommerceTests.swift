import XCTest

@testable import RocentoCore

final class MemoryCredential: CredentialStorage, @unchecked Sendable {
  private let lock = NSLock()
  private var value: String?
  init(_ value: String? = nil) { self.value = value }
  func read() -> String? {
    lock.lock()
    defer { lock.unlock() }
    return value
  }
  func save(_ value: String?) throws {
    lock.lock()
    defer { lock.unlock() }
    self.value = value
  }
}
actor CommerceTransport: HTTPTransport {
  var responses: [Result<HTTPResult, Error>]
  var requests: [URLRequest] = []
  let delay: UInt64
  init(_ responses: [Result<HTTPResult, Error>], delay: UInt64 = 0) {
    self.responses = responses
    self.delay = delay
  }
  func get(_ request: URLRequest, maxBytes: Int) async throws -> HTTPResult {
    XCTAssertEqual(maxBytes, request.url!.path.hasSuffix("analytics/events") ? 16_384 : 2_000_000)
    requests.append(request)
    if delay > 0 { try await Task.sleep(nanoseconds: delay) }
    guard !responses.isEmpty else { throw URLError(.badServerResponse) }
    return try responses.removeFirst().get()
  }
}
private struct RejectCredentialDeletion: CredentialStorage {
  let stored = MemoryCredential(String(repeating: "a", count: 64))
  func read() -> String? { stored.read() }
  func save(_ value: String?) throws {
    guard value != nil else { throw MobileFailure.unauthorized }
    try stored.save(value)
  }
}
private struct InaccessibleCredential: CredentialStorage {
  func read() -> String? { XCTFail("Unchecked reads hide access failures"); return nil }
  func readChecked() throws -> String? { throw MobileFailure.unauthorized }
  func save(_ value: String?) throws { XCTFail("Unreadable storage must not be overwritten") }
}
final class CommerceTests: XCTestCase {
  func testDeletionReceiptSurvivesLostResponseAndRecoversWithoutAuthentication() async throws {
    let receipts = MemoryCredential()
    let credentials = MemoryCredential()
    let attempts = MemoryCredential("private checkout")
    let reorders = MemoryCredential("private reorder")
    let transport = CommerceTransport(try [auth(), .failure(URLError(.networkConnectionLost)), response(["id": UUID().uuidString, "state": "requested"])])
    let client = CommerceClient(identity: try identity(), credentials: credentials, attempts: attempts, transport: transport, reorders: reorders, deletionReceipts: receipts)
    _ = try await client.login(identifier: "fixture", password: "test")
    let policy = AccountRetentionPolicy(id: UUID().uuidString, legal_entity: "Merchant", jurisdictions: ["Configured"], financial_days: 30, retain_contact: false, retain_address: false)
    do { _ = try await client.deleteAccount(policy: policy, password: "private password"); XCTFail("Expected lost response") }
    catch is URLError {}
    let saved = try await client.accountDeletionReceipt()
    XCTAssertEqual(saved?.receipt_token.count, 64)
    XCTAssertFalse(receipts.read()!.contains("private password"))
    let recovered = try await client.accountDeletionStatus()
    XCTAssertEqual(recovered?.state, "requested")
    XCTAssertNil(credentials.read()); XCTAssertNil(attempts.read()); XCTAssertNil(reorders.read())
    XCTAssertNotNil(receipts.read())
    let requests = await transport.requests
    XCTAssertNil(requests.last?.value(forHTTPHeaderField: "Authorization"))
    XCTAssertNil(requests.last?.value(forHTTPHeaderField: "Cookie"))
    let body = try JSONSerialization.jsonObject(with: requests[1].httpBody!) as! [String: Any]
    XCTAssertEqual(body["request_id"] as? String, saved?.request_id)
  }
  func testAcceptedDeletionSurfacesCleanupFailureWithoutLosingReceipt() async throws {
    let receipts = MemoryCredential()
    let transport = CommerceTransport(try [auth(), response(["id": UUID().uuidString, "state": "requested"])])
    let client = CommerceClient(identity: try identity(), credentials: RejectCredentialDeletion(), attempts: MemoryCredential(), transport: transport, deletionReceipts: receipts)
    _ = try await client.restore()
    let policy = AccountRetentionPolicy(id: UUID().uuidString, legal_entity: "Merchant", jurisdictions: ["Configured"], financial_days: 0, retain_contact: false, retain_address: false)
    do { _ = try await client.deleteAccount(policy: policy, password: "test"); XCTFail("Expected cleanup failure") }
    catch let error as AccountDeletionCleanupFailure { XCTAssertEqual(error.status.state, "requested") }
    XCTAssertNotNil(receipts.read())
  }
  func testDeletionDoesNotDispatchWhenReceiptStorageFails() async throws {
    let transport = CommerceTransport(try [auth()])
    let client = CommerceClient(identity: try identity(), credentials: MemoryCredential(), attempts: MemoryCredential(), transport: transport, deletionReceipts: InaccessibleCredential())
    _ = try await client.login(identifier: "fixture", password: "test")
    let policy = AccountRetentionPolicy(id: UUID().uuidString, legal_entity: "Merchant", jurisdictions: ["Configured"], financial_days: 0, retain_contact: false, retain_address: false)
    do { _ = try await client.deleteAccount(policy: policy, password: "test"); XCTFail("Expected inaccessible receipt") }
    catch MobileFailure.unauthorized {}
    let requests = await transport.requests
    XCTAssertEqual(requests.count, 1)
  }
  func testInaccessibleCredentialsFailWithoutNetworkOrOverwrite() async throws {
    let transport = CommerceTransport([])
    let blocked = InaccessibleCredential()
    let client = CommerceClient(identity: try identity(), credentials: blocked, attempts: blocked, transport: transport)
    do { _ = try await client.restore(); XCTFail("Expected checked read failure") }
    catch MobileFailure.unauthorized {}
    let requests = await transport.requests
    XCTAssertTrue(requests.isEmpty)
    let signedIn = CommerceClient(identity: try identity(), credentials: MemoryCredential(), attempts: blocked, transport: CommerceTransport(try [auth()]))
    _ = try await signedIn.login(identifier: "fixture", password: "test")
    do { _ = try await signedIn.pendingCheckout(); XCTFail("Expected checked read failure") }
    catch MobileFailure.unauthorized {}
  }
  func testSharedMalformedCommercePayloadsFailDecoding() throws {
    let url = Bundle.module.url(forResource: "invalid-commerce", withExtension: "json")!
    let cases = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
    let decoder = JSONDecoder()
    XCTAssertThrowsError(try decoder.decode(CustomerAuth.self, from: JSONSerialization.data(withJSONObject: cases["malformed_auth"]!)))
    XCTAssertThrowsError(try decoder.decode(CommerceCart.self, from: JSONSerialization.data(withJSONObject: cases["malformed_cart"]!)))
    XCTAssertThrowsError(try decoder.decode(CommerceQuote.self, from: JSONSerialization.data(withJSONObject: cases["malformed_quote"]!)))
  }

  @MainActor func testLogoutReportsCredentialDeletionFailure() async throws {
    let credentials = RejectCredentialDeletion()
    let transport = CommerceTransport(try [auth()])
    let client = CommerceClient(identity: try identity(), credentials: credentials, attempts: MemoryCredential(), transport: transport)
    let account = AccountStore(client: client)
    try await account.restore()
    do { try await account.logout(); XCTFail("Storage failure must reach action feedback") }
    catch MobileFailure.unauthorized {}
    XCTAssertNil(account.customer)
    let customer = await client.customer
    XCTAssertNil(customer)
    XCTAssertNotNil(credentials.read())
  }
  @MainActor func testPasswordResetLogsOutOnceAndClearsAccount() async throws {
    let transport = CommerceTransport(try [auth(), response([:]), response([:])])
    let credentials = MemoryCredential()
    let client = CommerceClient(identity: try identity(), credentials: credentials, attempts: MemoryCredential(), transport: transport)
    let account = AccountStore(client: client)
    try await account.login("fixture", password: "test")
    try await account.auth("reset-password", identifier: "fixture", password: "replacement", code: "code")
    let requests = await transport.requests
    XCTAssertEqual(requests.filter { $0.url!.path.hasSuffix("/logout") }.count, 1)
    XCTAssertNil(account.customer)
    XCTAssertNil(credentials.read())
  }
  func memoryFixture(guest: Bool = false) -> [String: Any] { ["enabled": true, "guest": guest, "personalized": true, "journey_consent": false, "consent_version": 3, "preferences": [], "signals": [], "categories": [["id": productID, "name": "Gifts"]], "products": []] }
  @MainActor func testMemoryUnknownWriteRequiresReadbackAndResetClearsPrivateState() async throws {
    let view = memoryFixture()
    let transport = CommerceTransport(try [auth(), response(view), response([]), response(["goals": []]), response(["error": "lost"], status: 503), response(view), response([]), response(["goals": []]), response(["memory": view, "contexts": [], "consents": []])])
    let client = CommerceClient(identity: try identity(), credentials: MemoryCredential(), attempts: MemoryCredential(), transport: transport)
    _ = try await client.login(identifier: "fixture", password: "test")
    let store = AssistantLibrary(client: client); try await store.refresh(conversation: productID, signedIn: true)
    var draft = MemoryPreferenceInput(); draft.attribute = "color"; draft.value = "blue"; draft.category_id = productID; store.edit(draft)
    for _ in 0..<2 { do { try await store.mutate(.preference(draft), conversation: productID, signedIn: true); XCTFail("must fail") } catch {} }
    XCTAssertTrue(store.needsRefresh); XCTAssertEqual(store.draft.value, "blue")
    let requests = await transport.requests; XCTAssertEqual(requests.filter { $0.httpMethod == "POST" && $0.url!.path.hasSuffix("preferences") }.count, 1)
    try await store.refresh(conversation: productID, signedIn: true); XCTAssertFalse(store.needsRefresh)
    try await store.export(); XCTAssertTrue(store.exported!.contains("consents")); store.reset(); XCTAssertNil(store.exported); XCTAssertNil(store.memory); XCTAssertTrue(store.history.isEmpty)
  }
  @MainActor func testSavedConversationRestoresWithoutStreamOrCheckoutAndMissingGoalFails() async throws {
    let turn: [String: Any] = ["conversation_id": productID, "request_id": productID, "question": "Find a gift", "answer": "Suggestion", "created_at": "2026-10-13T00:00:00Z", "blocks": []]
    let transport = CommerceTransport(try [auth(), response([turn]), response([]), response(["goals": []])])
    let client = CommerceClient(identity: try identity(), credentials: MemoryCredential(), attempts: MemoryCredential(), transport: transport)
    _ = try await client.login(identifier: "fixture", password: "test")
    let store = AssistantLibrary(client: client), chat = AssistantStore(client: client)
    try await store.open(productID) { try chat.restoreConversation(productID, history: $0) }
    XCTAssertEqual(chat.conversationID, productID); XCTAssertEqual(chat.turns.first?.question, "Find a gift"); XCTAssertEqual(chat.turns.first?.reply.opensCheckout, false)
    do { try await store.open(productID) { _ in XCTFail("unavailable must not replace chat") }; XCTFail("must fail") } catch {}
    do { try await store.resumeGoal(productID) { _ in XCTFail("missing goal must not resume") }; XCTFail("must fail") } catch {}
    let requests = await transport.requests; XCTAssertFalse(requests.contains { $0.url!.path.hasSuffix("chat") })
    let turns = try JSONDecoder().decode([HistoryTurn].self, from: JSONSerialization.data(withJSONObject: [turn, turn])); XCTAssertThrowsError(try HistoryTurn.validate(turns))
  }
  func testGuestMemoryRetainsCookieAndFailsClosedWithoutOwnership() async throws {
    let cookie = String(repeating: "g", count: 48)
    let transport = CommerceTransport(try [response(memoryFixture(guest: true), headers: ["Set-Cookie": "assistant_guest=\(cookie); HttpOnly"]), response(["status": "ok"])])
    let client = CommerceClient(identity: try identity(), credentials: MemoryCredential(), attempts: MemoryCredential(), transport: transport)
    _ = try await client.memoryView(productID); try await client.changeMemory(.consent(personalized: false, journey: false, version: 3))
    let requests = await transport.requests; XCTAssertEqual(requests[1].value(forHTTPHeaderField: "Cookie"), "assistant_guest=\(cookie)"); XCTAssertNil(requests[1].value(forHTTPHeaderField: "Authorization"))
    let missing = CommerceClient(identity: try identity(), credentials: MemoryCredential(), attempts: MemoryCredential(), transport: CommerceTransport(try [response(memoryFixture(guest: true))]))
    do { _ = try await missing.memoryView(productID); XCTFail("must reject ownerless memory") } catch {}
  }
  func supportFixture() -> [String: Any] { ["ticket": ["id": productID, "number": 42, "subject": "Delivery", "category": "order_issue", "status": "open", "priority": "normal", "order_id": productID, "created_at": "2026-10-13T00:00:00Z"], "messages": [["id": productID, "sender": "customer", "body": "Where is it?", "created_at": "2026-10-13T00:00:00Z"]]] }
  @MainActor func testSupportCreateAndReplyRetryExactAttempts() async throws {
    let detail = supportFixture()
    let transport = CommerceTransport(try [auth(), response(["error": "lost"], status: 503), response(detail), response([detail["ticket"]!]), response(detail), response(["error": "lost"], status: 503), response(detail), response(detail)])
    let client = CommerceClient(identity: try identity(), credentials: MemoryCredential(), attempts: MemoryCredential(), transport: transport)
    _ = try await client.login(identifier: "fixture", password: "test")
    let store = SupportStore(client: client); var draft = SupportInput(); draft.subject = "Delivery"; draft.body = "Where is it?"; draft.order_id = productID
    store.compose(order: productID); store.edit(draft)
    do { try await store.create(signedIn: true); XCTFail("must fail") } catch {}
    XCTAssertNotNil(store.attempt); draft.body = "changed"; store.edit(draft); XCTAssertEqual(store.draft.body, "Where is it?")
    try await store.create(signedIn: true); XCTAssertTrue(store.created); XCTAssertNil(store.attempt)
    store.showList(); try await store.refresh(); XCTAssertEqual(store.tickets.count, 1); try await store.open(productID); store.editReply("Please check")
    do { try await store.sendReply(); XCTFail("must fail") } catch {}
    store.editReply("changed"); XCTAssertEqual(store.reply, "Please check"); try await store.open(productID); XCTAssertEqual(store.reply, "Please check")
    try await store.sendReply(); XCTAssertTrue(store.replied); XCTAssertNil(store.replyAttempt)
    let requests = await transport.requests
    XCTAssertEqual(requests[1].httpBody, requests[2].httpBody); XCTAssertEqual(requests[5].httpBody, requests[7].httpBody)
    XCTAssertEqual(requests[7].value(forHTTPHeaderField: "Authorization"), "Bearer customer-access")
    let payload = try JSONSerialization.jsonObject(with: requests[7].httpBody!) as! [String: Any]; XCTAssertEqual(Set(payload.keys), ["request_id", "body"])
    draft.body = String(repeating: "ع", count: 1001); XCTAssertFalse(draft.valid(signedIn: true)); store.reset(); XCTAssertTrue(store.tickets.isEmpty); XCTAssertNil(store.detail)
  }
  @MainActor func testGuestSupportCookieAndValidationFailure() async throws {
    let cookie = String(repeating: "g", count: 48)
    let transport = CommerceTransport(try [response(["status": "ok"], headers: ["Set-Cookie": "support_guest=\(cookie); HttpOnly"]), response(["error": "lost"], status: 503), response(supportFixture()), response(["error": "invalid"], status: 422)])
    let client = CommerceClient(identity: try identity(), credentials: MemoryCredential(), attempts: MemoryCredential(), transport: transport)
    let store = SupportStore(client: client); var draft = SupportInput(); draft.subject = "Question"; draft.body = "Please help"; draft.contact_name = "Mona"; draft.contact = "mona@example.test"; store.edit(draft)
    do { try await store.create(signedIn: false); XCTFail("must fail") } catch {}
    try await store.create(signedIn: false)
    let requests = await transport.requests
    XCTAssertEqual(requests.count, 3); XCTAssertEqual(requests[1].httpBody, requests[2].httpBody); XCTAssertEqual(requests[1].value(forHTTPHeaderField: "Cookie"), "support_guest=\(cookie)"); XCTAssertNil(requests[1].value(forHTTPHeaderField: "Authorization"))
    store.compose(); store.edit(draft); do { try await store.create(signedIn: false); XCTFail("must fail") } catch {}
    XCTAssertNil(store.attempt)
  }
  func testOrderContentsDecodeWithoutBreakingOlderResponses() throws {
    var fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: Bundle.module.url(forResource: "commerce-flow", withExtension: "json")!)) as! [String: Any]
    let legacy = try JSONDecoder().decode(CustomerOrderDetail.self, from: JSONSerialization.data(withJSONObject: fixture["detail"]!))
    XCTAssertNil(legacy.items)
    var detail = fixture["detail"] as! [String: Any]; var order = detail["order"] as! [String: Any]
    order["gift_message"] = "Happy birthday"; order["subtotal"] = "25.00"; detail["order"] = order
    detail["items"] = [["product_id": productID, "name": "Apples", "quantity": 2, "price": "12.50", "line_total": "25.00", "discount_amount": "2.00", "unit": "kg"]]
    fixture["detail"] = detail
    let current = try JSONDecoder().decode(CustomerOrderDetail.self, from: JSONSerialization.data(withJSONObject: detail))
    XCTAssertEqual(current.order.gift_message, "Happy birthday"); XCTAssertEqual(current.items?.first?.discount_amount, "2.00"); XCTAssertEqual(current.items?.first?.quantity, 2)
  }
  @MainActor func testComparisonSelectionFactsAndReset() async throws {
    let store = ComparisonStore()
    for index in 0...5 { store.toggle("90000000-0000-4000-8000-00000000000\(index)") }
    store.toggle("invalid"); XCTAssertEqual(store.ids.count, 5); XCTAssertTrue(store.prompt.contains("/products/"))
    XCTAssertEqual(ComparisonStore.value(.bool(false), locale: "en"), "No")
    XCTAssertEqual(ComparisonStore.value(.object([:]), locale: "en"), "Not provided")
    await store.load { _ in throw URLError(.badServerResponse) }; XCTAssertEqual(store.failed.count, 5)
    let value = try JSONDecoder().decode(ComparisonProduct.self, from: Data("""
      {"id":"\(store.ids[0])","name":"A","description":"","price":"25.00","currency":"USD","in_stock":true,"product_type":"configurable","attributes":{"organic":true}}
      """.utf8))
    await store.load { _ in store.reset(); return value }
    XCTAssertTrue(store.products.isEmpty); XCTAssertTrue(store.ids.isEmpty)
  }
  @MainActor func testReviewUnknownOutcomeRequiresReadbackAndRetainsDraft() async throws {
    let review: [String: Any] = ["id": productID, "display_name": "Mona", "rating": 4, "title": "Fresh", "body": "Good quality", "created_at": "2026-10-13T00:00:00Z", "status": "pending", "version": 1]
    let transport = CommerceTransport(try [auth(), response([]), .success(HTTPResult(status: 200, headers: [:], body: Data("null".utf8))), response(["error": "lost reply"], status: 503), response([]), response(review), response(review), response(["error": "refresh failed"], status: 503)])
    let client = CommerceClient(identity: try identity(), credentials: MemoryCredential(), attempts: MemoryCredential(), transport: transport)
    _ = try await client.login(identifier: "fixture", password: "test")
    let store = ReviewsStore(client: client)
    try await store.open(productID, signedIn: true)
    var input = ReviewInput(); input.display_name = "Mona"; input.rating = 4; input.title = "Fresh"; input.body = "Good quality"
    store.edit(input)
    do { try await store.submit(verified: false); XCTFail() } catch {}
    do { try await store.submit(verified: true); XCTFail() } catch {}
    XCTAssertTrue(store.uncertain)
    do { try await store.submit(verified: true); XCTFail() } catch {}
    try await store.load(signedIn: true, offset: 50)
    XCTAssertEqual(store.offset, 50); XCTAssertEqual(store.draft, input); XCTAssertEqual(store.own?.status, "pending"); XCTAssertFalse(store.uncertain)
    let requests = await transport.requests; XCTAssertEqual(requests.filter { $0.httpMethod == "PUT" }.count, 1)
    let write = requests.first { $0.httpMethod == "PUT" }!
    XCTAssertEqual(write.value(forHTTPHeaderField: "Authorization"), "Bearer customer-access")
    XCTAssertEqual(try JSONDecoder().decode(ReviewInput.self, from: write.httpBody!), input)
    try await store.submit(verified: true)
    XCTAssertTrue(store.submitted); XCTAssertFalse(store.uncertain); XCTAssertTrue(store.failed)
    input.display_name = String(repeating: "ع", count: 41); XCTAssertFalse(input.valid)
    store.reset(); XCTAssertNil(store.own); XCTAssertTrue(store.draft.title.isEmpty)
  }
  func testRelationshipsUseCustomerDeliveryAndLocaleAndValidateBounds() async throws {
    let transport = CommerceTransport([try auth(), try response([])])
    let client = CommerceClient(identity: try identity(), credentials: MemoryCredential(), attempts: MemoryCredential(), transport: transport)
    _ = try await client.login(identifier: "fixture", password: "test")
    await client.setDelivery(try DeliveryPin(latitude: 30, longitude: 31))
    _ = try await client.relationships([productID, productID], kind: "cross_sell", locale: "ar")
    do { _ = try await client.relationships([], kind: "related", locale: "en"); XCTFail() } catch {}
    do { _ = try await client.relationships(Array(repeating: productID, count: 51), kind: "related", locale: "en"); XCTFail() } catch {}
    let requests = await transport.requests; XCTAssertEqual(requests.count, 2)
    let request = requests[1]
    XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer customer-access")
    XCTAssertEqual(request.value(forHTTPHeaderField: "X-Delivery-Latitude"), "30.0")
    XCTAssertEqual(request.value(forHTTPHeaderField: "X-Storefront-Locale"), "ar")
    let query = Dictionary(uniqueKeysWithValues: URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!.map { ($0.name, $0.value!) })
    XCTAssertEqual(query["sources"], productID); XCTAssertEqual(query["kind"], "cross_sell")
  }
  @MainActor func testReorderRecoversLostApplyWithoutRepeatingMutation() async throws {
    let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: Bundle.module.url(forResource: "commerce-flow", withExtension: "json")!)) as! [String: Any]
    let order = try JSONDecoder().decode(CustomerOrder.self, from: JSONSerialization.data(withJSONObject: fixture["order"]!))
    let location = (fixture["location"] as! [String: Any])["id"] as! String
    let proposal: [String: Any] = ["id": productID, "can_apply": true, "applied": false, "expires_at": "2099-01-01T00:00:00Z"]
    let context: [String: Any] = ["task_revision": 3, "source_revision": 7]
    let transport = CommerceTransport(try [auth(), response(fixture["cart"]!), response(fixture["locations"]!), response(context), response(fixture["locations"]!), response(fixture["cart"]!), response(context), response(proposal), response(proposal), response(["status": "ok"]), response(["error": "reply lost"], status: 503), response(fixture["cart"]!), response(fixture["locations"]!), response(["proposal_id": productID]), response(["id": productID, "applied": true])])
    let storage = MemoryCredential()
    let client = CommerceClient(identity: try identity(), credentials: MemoryCredential(), attempts: MemoryCredential(), transport: transport, reorders: storage)
    _ = try await client.login(identifier: "fixture", password: "test")
    let store = ReorderStore(client: client, checkout: CheckoutFlow(), accept: { _ in })
    try await store.start(order); try await store.prepare(location: location, replace: false)
    do { try await store.approve(); XCTFail("Expected lost response") } catch is CommerceFailure {}
    XCTAssertTrue(store.pending)
    let saved = try await client.reorderTask(order.id); XCTAssertTrue(saved.pending)
    let restarted = ReorderStore(client: client, checkout: CheckoutFlow(), accept: { _ in })
    try await restarted.start(order); XCTAssertTrue(restarted.done)
    let requests = await transport.requests
    XCTAssertEqual(requests.filter { $0.url!.path.hasSuffix("/apply") }.count, 1)
    XCTAssertFalse(requests.contains { $0.url!.path.contains("/checkout/") || $0.url!.path.contains("/cart/items") })
    let body = try JSONSerialization.jsonObject(with: requests.first { $0.url!.path.hasSuffix("/proposals") }!.httpBody!) as! [String: Any]
    XCTAssertEqual(body["mode"] as? String, "buy_again"); XCTAssertEqual(body["source_revision"] as? Int, 7)
    XCTAssertEqual(body["task_revision"] as? Int, 3); XCTAssertEqual(body["location_id"] as? String, location)
  }
  func testReorderTaskPersistsAcrossClientsAndRejectsCorruptStorage() async throws {
    let storage = MemoryCredential()
    let first = CommerceClient(identity: try identity(), credentials: MemoryCredential(), attempts: MemoryCredential(), transport: CommerceTransport([try auth()]), reorders: storage)
    _ = try await first.login(identifier: "fixture", password: "test")
    let task = try await first.reorderTask(productID)
    try await first.saveReorderTask(productID, task: ReorderTask(task: task.task, pending: true))
    let next = CommerceClient(identity: try identity(), credentials: MemoryCredential(), attempts: MemoryCredential(), transport: CommerceTransport([try auth()]), reorders: storage)
    _ = try await next.login(identifier: "fixture", password: "test")
    let restored = try await next.reorderTask(productID)
    XCTAssertEqual(restored.task, task.task); XCTAssertTrue(restored.pending)
    try storage.save("corrupt")
    do { _ = try await next.reorderTask(productID); XCTFail("Must not invent a new task") } catch {}
    XCTAssertEqual(storage.read(), "corrupt")
  }
  func testGiftMessageQuoteContractAndByteLimit() async throws {
    let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: Bundle.module.url(forResource: "commerce-flow", withExtension: "json")!)) as! [String: Any]
    let transport = CommerceTransport([try auth(), try response(fixture["quote"]!)])
    let client = CommerceClient(identity: try identity(), credentials: MemoryCredential(), attempts: MemoryCredential(), transport: transport)
    _ = try await client.login(identifier: "fixture@example.test", password: "test")
    _ = try await client.quote(location: productID, giftMessage: "Happy birthday")
    do { _ = try await client.quote(location: productID, giftMessage: String(repeating: "ع", count: 251)); XCTFail() } catch is CommerceFailure {}
    let requests = await transport.requests
    XCTAssertEqual(requests.count, 2); XCTAssertEqual(requests[1].url?.path, "/api/v1/customer/checkout/quote")
    XCTAssertEqual(try JSONSerialization.jsonObject(with: requests[1].httpBody!) as? [String: String], ["location_id": productID, "gift_message": "Happy birthday"])
  }
  func testCartCouponsUseServerAmountsAndAuthenticatedEndpoint() async throws {
    let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: Bundle.module.url(forResource: "commerce-flow", withExtension: "json")!)) as! [String: Any]
    var discounted = fixture["cart"] as! [String: Any]
    discounted["discount_amount"] = "2.50"; discounted["coupon_code"] = "REALCODE"
    let transport = CommerceTransport(try [auth(), response(discounted), response(fixture["cart"]!), response(["error":"Not eligible"], status:422)])
    let client = CommerceClient(identity: try identity(), credentials: MemoryCredential(), attempts: MemoryCredential(), transport: transport)
    _ = try await client.login(identifier:"fixture@example.test", password:"test")
    let applied = try await client.coupon(" REALCODE ")
    XCTAssertEqual(applied.coupon_code,"REALCODE"); XCTAssertEqual(Decimal(string:applied.itemsTotal),Decimal(string:"22.50"))
    let removed = try await client.coupon(""); XCTAssertNil(removed.coupon_code); XCTAssertEqual(Decimal(string:removed.itemsTotal),Decimal(string:"25"))
    do { _ = try await client.coupon("BAD"); XCTFail("Expected rejection") } catch let error as CommerceFailure { XCTAssertEqual(error.status,422) }
    let requests = await transport.requests
    for request in requests.dropFirst() { XCTAssertEqual(request.httpMethod,"PUT");XCTAssertEqual(request.url?.path,"/api/v1/cart/coupon");XCTAssertEqual(request.value(forHTTPHeaderField:"Authorization"),"Bearer customer-access") }
    XCTAssertEqual(try JSONSerialization.jsonObject(with: requests[1].httpBody!) as? [String:String], ["code":"REALCODE"])
    XCTAssertEqual(try JSONSerialization.jsonObject(with: requests[2].httpBody!) as? [String:String], ["code":""])
  }

  func testPushRegistrationIsAuthenticatedAndOwnerBound() async throws {
    let transport = CommerceTransport([try auth(), try response(["status":"ok"]), try response(["status":"ok"])])
    let client = CommerceClient(identity: try identity(), credentials: MemoryCredential(), attempts: MemoryCredential(), transport: transport)
    _ = try await client.login(identifier: "fixture@example.test", password: "test")
    await client.setLocale("ar")
    try await client.registerPushDevice(productID, appID: "com.rocento.grocery", token: String(repeating: "ab", count: 32), customerID: productID)
    try await client.unregisterPushDevice(productID)
    let requests = await transport.requests
    XCTAssertEqual(requests[1].httpMethod, "PUT"); XCTAssertEqual(requests[2].httpMethod, "DELETE")
    XCTAssertEqual(requests[1].url?.path, "/api/v1/customer/push-devices/" + productID)
    XCTAssertEqual(requests[1].value(forHTTPHeaderField: "Authorization"), "Bearer customer-access")
    let body = try JSONSerialization.jsonObject(with: requests[1].httpBody!) as! [String: String]
    XCTAssertEqual(body["customer_id"], productID); XCTAssertEqual(body["platform"], "ios"); XCTAssertEqual(body["locale"], "ar")
    do { try await client.unregisterPushDevice("../other"); XCTFail("Expected invalid ID") } catch {}
    let count = await transport.requests.count; XCTAssertEqual(count, 3)
  }

  func testWishlistUsesAuthenticatedIdempotentEndpoints() async throws {
    let transport = CommerceTransport([try auth(), try response([productID]), try response(["status":"ok"]), try response(["status":"ok"]), try response(["error":"unavailable"], status:503)])
    let client = CommerceClient(identity: try identity(), credentials: MemoryCredential(), attempts: MemoryCredential(), transport: transport)
    _ = try await client.login(identifier:"fixture@example.test", password:"test")
    let ids = try await client.wishlist(); XCTAssertEqual(ids, [productID])
    try await client.saveProduct(productID, saved:true)
    try await client.saveProduct(productID, saved:false)
    do { try await client.saveProduct(productID, saved:true); XCTFail("Expected server failure") } catch let e as CommerceFailure { XCTAssertEqual(e.status,503) }
    let requests = await transport.requests
    XCTAssertEqual(requests.dropFirst().map { $0.httpMethod! }, ["GET","PUT","DELETE","PUT"])
    XCTAssertEqual(requests[1].url?.path,"/api/v1/customer/wishlist")
    XCTAssertEqual(requests[2].url?.path,"/api/v1/customer/wishlist/" + productID)
    for request in requests.dropFirst() { XCTAssertEqual(request.value(forHTTPHeaderField:"Authorization"),"Bearer customer-access") }
  }
  func testCategoryBrowseUsesScopedServerFilters() async throws {
    let transport = CommerceTransport([try response(["hits": [], "total": 0, "facets": [:]] as [String: Any])])
    let client = CommerceClient(identity: try identity(), credentials: MemoryCredential(), attempts: MemoryCredential(), transport: transport)
    var filters = CatalogFilters()
    filters.query = "pear & apple"; filters.minimum = "2"; filters.maximum = "9"; filters.inStock = true; filters.sort = "price_desc"
    filters.attributes = ["organic": ["true"]]; filters.attributeTypes = ["organic": "boolean"]
    let page = try await client.browse(category: productID, filters: filters, offset: 24, locale: "ar")
    XCTAssertEqual(page.total, 0)
    let request = await transport.requests[0]
    let query = Dictionary(uniqueKeysWithValues: URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!.map { ($0.name, $0.value!) })
    XCTAssertEqual(query["category_id"], productID); XCTAssertEqual(query["q"], "pear & apple")
    XCTAssertEqual(query["offset"], "24"); XCTAssertEqual(query["min_price"], "2"); XCTAssertEqual(query["sort_order"], "desc")
    XCTAssertEqual(query["attribute_filters"], "{\"organic\":[true]}")
    filters.minimum = "10"; XCTAssertFalse(filters.valid)
    filters.minimum = "NaN"; XCTAssertFalse(filters.valid)
  }
  let customerID = "00000000-0000-0000-0000-000000000001"
  let quoteID = "00000000-0000-0000-0000-000000000002"
  let productID = "00000000-0000-0000-0000-000000000003"
  let refresh = String(repeating: "a", count: 64)
  func identity() throws -> AppIdentity {
    try AppIdentity(
      merchantID: customerID, environment: "production",
      commerceBaseURL: URL(string: "https://grocery.example.test/api")!)
  }
  func response(_ value: Any, status: Int = 200, headers: [String: String] = [:]) throws -> Result<
    HTTPResult, Error
  > {
    .success(
      HTTPResult(
        status: status, headers: headers, body: try JSONSerialization.data(withJSONObject: value)))
  }
  func auth(_ token: String = "customer-access", customer: String? = nil) throws -> Result<
    HTTPResult, Error
  > {
    try response(
      [
        "customer": [
          "id": customer ?? customerID, "primary_identifier": "email", "email": "fixture@example.test",
          "verified": true,
        ], "access_token": token,
      ],
      headers: [
        "Set-Cookie":
          "customer_refresh=\(refresh); HttpOnly; Secure; Path=/, guest_cart=; Max-Age=0, assistant_guest=; Max-Age=0"
      ])
  }
  func quote(_ id: String? = nil) throws -> CommerceQuote {
    try JSONDecoder().decode(
      CommerceQuote.self,
      from: JSONSerialization.data(withJSONObject: [
        "id": id ?? quoteID, "expires_at": "2030-01-01T00:00:00Z",
        "snapshot": [
          "subtotal": "25.00", "discount_amount": "0.00", "delivery_fee": "5.00",
          "tax_amount": "0.00", "total": "30.00", "currency": "EGP",
          "payment_method": "cash_on_delivery",
        ],
      ]))
  }
  func order() throws -> Result<HTTPResult, Error> {
    try response([
      "order": [
        "id": productID, "number": 42, "status": "placed", "total": "30.00", "currency": "EGP",
        "created_at": "2026-10-11T00:00:00Z",
      ], "history": [],
    ])
  }
  func testRefreshRotationAndCredentialBoundaries() async throws {
    let transport = CommerceTransport(
      try [
        auth(), response(["error": "expired"], status: 401), auth("rotated-access"), response([]),
        response([]),
      ])
    let store = MemoryCredential()
    let client = CommerceClient(
      identity: try identity(), credentials: store, attempts: MemoryCredential(),
      transport: transport)
    _ = try await client.login(identifier: "fixture@example.test", password: "test-only-password")
    _ = try await client.orders()
    _ = try await client.categories(locale: "ar")
    let requests = await transport.requests
    XCTAssertEqual(
      requests.map { $0.url!.path },
      [
        "/api/v1/customer/auth/login", "/api/v1/customer/orders", "/api/v1/customer/auth/refresh",
        "/api/v1/customer/orders", "/api/v1/catalog/categories",
      ])
    XCTAssertNil(requests[0].value(forHTTPHeaderField: "Authorization"))
    XCTAssertEqual(requests[2].value(forHTTPHeaderField: "Cookie"), "customer_refresh=\(refresh)")
    XCTAssertNil(requests[2].value(forHTTPHeaderField: "Authorization"))
    XCTAssertEqual(requests[3].value(forHTTPHeaderField: "Authorization"), "Bearer rotated-access")
    XCTAssertNil(requests[4].value(forHTTPHeaderField: "Authorization"))
    XCTAssertNil(requests[4].value(forHTTPHeaderField: "Cookie"))
    XCTAssertEqual(requests[4].value(forHTTPHeaderField: "X-Storefront-Locale"), "ar")
    XCTAssertTrue(
      requests.allSatisfy {
        $0.url?.host == "grocery.example.test"
          && $0.value(forHTTPHeaderField: "X-Commerce-Request") == "1"
      })
    XCTAssertEqual(store.read(), refresh)
  }
  func testCheckoutRetrySurvivesRestartLogoutAndAnotherCustomer() async throws {
    let transport = CommerceTransport(
      try [
        auth(), .failure(URLError(.timedOut)), response([:]), auth(customer: productID),
        response([:]), auth(), order(),
      ])
    let credentials = MemoryCredential()
    let attempts = MemoryCredential()
    var client = CommerceClient(
      identity: try identity(), credentials: credentials, attempts: attempts, transport: transport)
    _ = try await client.login(identifier: "fixture@example.test", password: "test")
    do {
      _ = try await client.place(quote())
      XCTFail("expected timeout")
    } catch is URLError {}
    let pending = try await client.pendingCheckout()
    XCTAssertNotNil(pending)
    do {
      _ = try await client.place(quote(productID))
      XCTFail("must block a different quote")
    } catch let e as CommerceFailure { XCTAssertEqual(e.status, 409) }
    try await client.logout()
    client = CommerceClient(
      identity: try identity(), credentials: credentials, attempts: attempts, transport: transport)
    _ = try await client.login(identifier: "other@example.test", password: "test")
    let hidden = try await client.pendingCheckout()
    XCTAssertNil(hidden)
    try await client.logout()
    _ = try await client.login(identifier: "fixture@example.test", password: "test")
    let restored = try await client.pendingCheckout()
    XCTAssertEqual(restored?.key, pending?.key)
    let detail = try await client.place(quote())
    XCTAssertEqual(detail.order.number, 42)
    XCTAssertNil(attempts.read())
    let requests = await transport.requests.filter { $0.url!.path.hasSuffix("checkout/place") }
    XCTAssertEqual(requests.count, 2)
    let a = try JSONSerialization.jsonObject(with: requests[0].httpBody!) as! NSDictionary
    let b = try JSONSerialization.jsonObject(with: requests[1].httpBody!) as! NSDictionary
    XCTAssertEqual(a, b)
  }
  func testDefinitiveRejectionAllowsNewReviewButServerFailureDoesNot() async throws {
    let transport = CommerceTransport(
      try [
        auth(), response(["error": "Review expired"], status: 400),
        response(["error": "busy"], status: 503),
      ])
    let client = CommerceClient(
      identity: try identity(), credentials: MemoryCredential(), attempts: MemoryCredential(),
      transport: transport)
    _ = try await client.login(identifier: "fixture@example.test", password: "test")
    do {
      _ = try await client.place(quote())
      XCTFail()
    } catch let e as CommerceFailure { XCTAssertEqual(e.status, 400) }
    let rejected = try await client.pendingCheckout()
    XCTAssertNil(rejected)
    do {
      _ = try await client.place(quote(productID))
      XCTFail()
    } catch let e as CommerceFailure { XCTAssertEqual(e.status, 503) }
    let uncertain = try await client.pendingCheckout()
    XCTAssertEqual(uncertain?.quote.id, productID)
  }
  func testExpiredRefreshClearsCredentialAndDoesNotLeakItToCatalog() async throws {
    let credentials = MemoryCredential(refresh)
    let transport = CommerceTransport([.success(HTTPResult(status: 204)), try response([])])
    let client = CommerceClient(
      identity: try identity(), credentials: credentials, attempts: MemoryCredential(),
      transport: transport)
    do {
      _ = try await client.restore()
      XCTFail()
    } catch let e as CommerceFailure { XCTAssertEqual(e.status, 401) }
    XCTAssertNil(credentials.read())
    _ = try await client.categories(locale: "en")
    let requests = await transport.requests
    XCTAssertNil(requests.last!.value(forHTTPHeaderField: "Cookie"))
  }
  func testDeliveryPinAndIdentifiersFailClosed() async throws {
    XCTAssertThrowsError(try DeliveryPin(latitude: .nan, longitude: 0))
    XCTAssertThrowsError(try DeliveryPin(latitude: 91, longitude: 0))
    let transport = CommerceTransport(try [response(["configured": true, "deliverable": false])])
    let client = CommerceClient(
      identity: try identity(), credentials: MemoryCredential(), attempts: MemoryCredential(),
      transport: transport)
    let coverage = try await client.coverage(DeliveryPin(latitude: 30, longitude: 31))
    XCTAssertFalse(coverage.deliverable)
    do {
      _ = try await client.order("../foreign")
      XCTFail()
    } catch let e as CommerceFailure { XCTAssertEqual(e.status, 422) }
    XCTAssertNil(client.imageURL("https://foreign.example/image"))
    let requests = await transport.requests
    XCTAssertEqual(requests.count, 1)
    XCTAssertEqual(requests[0].value(forHTTPHeaderField: "X-Delivery-Latitude"), "30.0")
  }
  func testCatalogVariantCartDeliveryQuoteAndOrderContract() async throws {
    let fixture =
      try JSONSerialization.jsonObject(
        with: Data(
          contentsOf: Bundle.module.url(forResource: "commerce-flow", withExtension: "json")!))
      as! [String: Any]
    let ids = fixture["ids"] as! [String: String]
    let transport = CommerceTransport(
      try [
        response(fixture["auth"]!, headers: ["Set-Cookie": "customer_refresh=\(refresh); Secure"]),
        response(fixture["categories"]!), response(["hits": [fixture["product"]!]]),
        response(fixture["family"]!), response(fixture["empty_cart"]!), response(fixture["cart"]!),
        response(fixture["coverage"]!), response(fixture["location"]!, status: 201),
        response(fixture["availability"]!), response(fixture["options"]!),
        response(fixture["plan"]!), response(fixture["quote"]!), response(fixture["detail"]!),
        response([fixture["order"]!]), response(fixture["detail"]!),
      ])
    let client = CommerceClient(
      identity: try identity(), credentials: MemoryCredential(), attempts: MemoryCredential(),
      transport: transport)
    _ = try await client.login(
      identifier: "native-fixture@example.test", password: "test-only-password")
    await client.setDelivery(try DeliveryPin(latitude: 30, longitude: 31))
    let categories = try await client.categories(locale: "ar")
    let products = try await client.products(category: categories[0].id, locale: "ar")
    let family = try await client.family(products[0].id)
    let cart = try await client.add(family.children[0].id)
    XCTAssertEqual(cart.subtotal, "25.00")
    let pin = try DeliveryPin(latitude: 30, longitude: 31)
    let coverage = try await client.coverage(pin)
    XCTAssertTrue(coverage.deliverable)
    let geography = ["country_code": "EG", "state_code": "11", "state_name": "Cairo", "city_id": "360630", "city_name": "Cairo"]
    let location = try await client.saveLocation(
      pin: pin, address: "Fixture delivery street", building: "1", floor: "2", apartment: "3",
      instructions: "", locationMethod: "neighborhood", geography: geography)
    await client.setDelivery(pin)
    let available = try await client.fulfillment()
    XCTAssertEqual(available.methods[0].asap, true)
    let options = try await client.deliveryOptions(
      method: "delivery", location: location.id, source: nil, date: "2026-10-11", asap: true)
    XCTAssertEqual(options.groups.count, 1)
    try await client.reserveDelivery(
      method: "delivery", location: location.id, source: nil, date: "2026-10-11", asap: true,
      windows: [], key: UUID().uuidString)
    let quote = try await client.quote(location: location.id)
    XCTAssertEqual(quote.snapshot.total, "30.00")
    let before = await transport.requests
    XCTAssertFalse(before.contains { $0.url!.path.hasSuffix("checkout/place") })
    let detail = try await client.place(quote)
    XCTAssertEqual(detail.order.number, 42)
    let orders = try await client.orders()
    let tracked = try await client.order(orders[0].id)
    XCTAssertEqual(tracked.history[0].status, "placed")
    let requests = await transport.requests
    let savedAddress = try JSONSerialization.jsonObject(with: requests[7].httpBody!) as! [String: Any]
    XCTAssertEqual(savedAddress["location_method"] as? String, "neighborhood")
    XCTAssertEqual(savedAddress["geography"] as? [String: String], geography)
    let add = try JSONSerialization.jsonObject(with: requests[5].httpBody!) as! [String: Any]
    XCTAssertEqual(add["product_id"] as? String, ids["variant"])
    let plan = try JSONSerialization.jsonObject(with: requests[10].httpBody!) as! [String: Any]
    XCTAssertEqual((plan["request"] as? [String: Any])?["location_id"] as? String, ids["location"])
    XCTAssertEqual(requests[11].value(forHTTPHeaderField: "X-Delivery-Latitude"), "30.0")
  }
  func testAnalyticsRequiresConsentAndNeverCarriesCommerceIdentity() async throws {
    let transport = CommerceTransport(try [response([:]), response([:])])
    let storage = MemoryCredential()
    let analytics = CommerceAnalytics(
      identity: try identity(), storage: storage, transport: transport)
    await analytics.record(.home)
    let empty = await transport.requests
    XCTAssertTrue(empty.isEmpty)
    try await analytics.consent(true)
    await analytics.record(.product)
    await analytics.record(.ordered)
    try await analytics.consent(false)
    await analytics.record(.home)
    let requests = await transport.requests
    XCTAssertEqual(requests.count, 2)
    XCTAssertNil(storage.read())
    for request in requests {
      XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
      XCTAssertNil(request.value(forHTTPHeaderField: "X-Delivery-Latitude"))
      let payload = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
      XCTAssertEqual(Set(payload.keys), Set(["id", "session_id", "event_type", "path", "source"]))
      XCTAssertFalse(String(data: request.httpBody!, encoding: .utf8)!.contains(customerID))
    }
  }

  func testConcurrentRestoresShareOneRefresh() async throws {
    let transport = CommerceTransport(try [auth()], delay: 20_000_000)
    let credentials = MemoryCredential(refresh)
    let client = CommerceClient(
      identity: try identity(), credentials: credentials, attempts: MemoryCredential(),
      transport: transport)
    async let first = client.restore()
    async let second = client.restore()
    let accounts = try await [first, second]
    XCTAssertEqual(accounts.map { $0.id }, [customerID, customerID])
    let requests = await transport.requests
    XCTAssertEqual(requests.count, 1)
    XCTAssertEqual(credentials.read(), refresh)
  }

}
