import XCTest
@testable import RocentoCore

@MainActor private final class FeatureGate {
  private var continuation: CheckedContinuation<Void, Never>?
  private var opened = false
  func wait() async { if !opened { await withCheckedContinuation { continuation = $0 } } }
  func open() { opened = true; continuation?.resume(); continuation = nil }
}
private actor PausedFeatureTransport: HTTPTransport {
  let started: XCTestExpectation
  let gate: FeatureGate
  let response: HTTPResult
  init(started: XCTestExpectation, gate: FeatureGate, response: HTTPResult) { self.started = started; self.gate = gate; self.response = response }
  func get(_ request: URLRequest, maxBytes: Int) async throws -> HTTPResult { started.fulfill(); await gate.wait(); return response }
}

@MainActor final class FeatureStoreTests: XCTestCase {
  private func data(_ key: String) throws -> Data {
    let raw = try Data(contentsOf: Bundle.module.url(forResource: "commerce-flow", withExtension: "json")!)
    let json = try JSONSerialization.jsonObject(with: raw) as! [String: Any]
    return try JSONSerialization.data(withJSONObject: json[key]!)
  }
  private func fixture<T: Decodable>(_ key: String, _: T.Type) throws -> T { try JSONDecoder().decode(T.self, from: data(key)) }
  private func client(_ replies: [Result<HTTPResult, Error>] = [], attempts: MemoryCredential = MemoryCredential()) throws -> CommerceClient {
    CommerceClient(identity: try AppIdentity(merchantID: "70000000-0000-0000-0000-000000000001", environment: "production", commerceBaseURL: URL(string: "https://grocery.example.test/api")!), credentials: MemoryCredential(), attempts: attempts, transport: CommerceTransport(replies))
  }
  private func auth() throws -> HTTPResult { HTTPResult(status: 200, headers: ["Set-Cookie": "customer_refresh=\(String(repeating: "f",count:64)); HttpOnly"], body: try data("auth")) }

  func testRejectedGuestLoginKeepsAuthenticationRouteForRetry() async throws {
    let session = ShoppingSession(client: try client([.success(HTTPResult(status: 401, body: Data("{\"error\":\"Invalid credentials\"}".utf8)))]))
    session.navigation.selectTab("account"); session.navigation.open("auth")
    let succeeded = await session.perform { try await session.account.login("fixture", password: "incorrect") }
    XCTAssertFalse(succeeded); XCTAssertNil(session.account.customer)
    XCTAssertEqual(session.navigation.panel, "auth")
    XCTAssertEqual(session.feedback.failure?.message, "Invalid credentials")
  }

  func testQueuedActionsRunInOrderAndFailuresReleaseQueue() async throws {
    let queue = OperationCoordinator(), gate = FeatureGate(); var events: [Int] = []
    let first = Task { try await queue.run { events.append(1); await gate.wait(); events.append(2) } }
    for _ in 0..<100 { if queue.busy { break }; await Task.yield() }
    let second = Task { try await queue.run { events.append(3) } }
    for _ in 0..<100 { if queue.pendingCount == 1 { break }; await Task.yield() }
    XCTAssertEqual(events,[1]); XCTAssertEqual(queue.pendingCount,1)
    gate.open(); try await first.value; try await second.value
    XCTAssertEqual(events,[1,2,3]); XCTAssertFalse(queue.busy)
    do { try await queue.run { throw URLError(.timedOut) }; XCTFail() } catch {}
    let result = try await queue.run { 42 }; XCTAssertEqual(result,42)
  }
  func testSessionChangeCancelsQueuedWorkAndAcceptsNewWork() async throws {
    let queue = OperationCoordinator(), gate = FeatureGate(); var executed = false
    let first = Task { try await queue.run { await gate.wait() } }
    for _ in 0..<100 { if queue.busy { break }; await Task.yield() }
    let second = Task { try await queue.run { executed = true } }
    for _ in 0..<100 { if queue.pendingCount == 1 { break }; await Task.yield() }
    queue.invalidatePending(); gate.open(); try await first.value
    do { try await second.value; XCTFail() } catch is CancellationError {}
    XCTAssertFalse(executed); try await queue.run { executed = true }; XCTAssertTrue(executed)
  }
  func testCancellationOfQueuedTaskDoesNotBlockFollowingWork() async throws {
    let queue = OperationCoordinator(), gate = FeatureGate()
    let first = Task { try await queue.run { await gate.wait() } }
    for _ in 0..<100 { if queue.busy { break }; await Task.yield() }
    let second = Task { try await queue.run { XCTFail("Cancelled operation executed") } }
    for _ in 0..<100 { if queue.pendingCount == 1 { break }; await Task.yield() }
    second.cancel(); gate.open(); try await first.value
    do { try await second.value; XCTFail() } catch is CancellationError {}
    XCTAssertFalse(queue.busy)
  }
  func testGuestLocationUsesCoverageWithoutSavingCustomerAddress() async throws {
    let checkout = CheckoutFlow(), form = DeliveryForm(checkout: checkout)
    let api = try client([.success(HTTPResult(status: 200, body: data("coverage")))])
    try await form.save(client: api, pin: DeliveryPin(latitude: 30, longitude: 31), address: "Guest location", building: "", floor: "", apartment: "", instructions: "", guest: true)
    XCTAssertEqual(form.state.guestAddress, "Guest location")
    XCTAssertNil(form.state.selection.location)
    form.reset(); XCTAssertNil(form.state.guestAddress)
  }
  func testDeliveryEditsInvalidateReviewButNotUncertainAttempt() async throws {
    let checkout = CheckoutFlow(), form = DeliveryForm(checkout: checkout)
    let quote = try fixture("quote",CommerceQuote.self)
    try await checkout.review { quote }
    form.update { $0.source = "branch"; $0.method = "pickup" }
    XCTAssertNil(checkout.quote); XCTAssertNil(form.state.selection.location)
    checkout.restore(quote); form.update { $0.method = "delivery" }
    XCTAssertEqual(form.state.method,"pickup"); XCTAssertEqual(checkout.quote?.id,quote.id)
  }
  func testSessionResetClearsFeaturesWithoutDeletingPendingStorage() throws {
    let attempts = MemoryCredential("saved-order-key"), session = ShoppingSession(client: try client(attempts: attempts))
    session.account.accept(try fixture("customer",CustomerAccount.self))
    session.cart.accept(try fixture("cart",CommerceCart.self))
    var address = AddressDraft(); address.address = "Private address"; session.delivery.editAddress(address)
    session.navigation.selectTab("account"); session.navigation.open("order")
    session.orders.show(try fixture("detail",CustomerOrderDetail.self))
    session.checkout.restore(try fixture("quote",CommerceQuote.self)); session.account.reset()
    XCTAssertNil(session.navigation.panel)
    XCTAssertNil(session.cart.value); XCTAssertNil(session.orders.detail); XCTAssertNil(session.account.customer)
    XCTAssertEqual(session.delivery.state.addressDraft.address,""); XCTAssertFalse(session.checkout.locked)
    XCTAssertEqual(attempts.read(),"saved-order-key")
  }
  func testLateLoginDoesNotRestorePreviousAccount() async throws {
    let started = expectation(description:"login request"), gate = FeatureGate()
    let transport = PausedFeatureTransport(started:started,gate:gate,response:try auth())
    let client = CommerceClient(identity:try AppIdentity(merchantID:"70000000-0000-0000-0000-000000000001",environment:"production",commerceBaseURL:URL(string:"https://grocery.example.test/api")!),credentials:MemoryCredential(),attempts:MemoryCredential(),transport:transport)
    let account = AccountStore(client:client)
    let login = Task { try await account.login("fixture",password:"test") }
    await fulfillment(of:[started],timeout:2); account.reset(); gate.open()
    do { try await login.value; XCTFail() } catch is CancellationError {}
    XCTAssertNil(account.customer)
  }
  func testCartMutationLocksAndRejectsLateResults() async throws {
    let checkout = CheckoutFlow(), cart = CartStore(client: try client(),checkout:checkout)
    let value = try fixture("cart",CommerceCart.self); checkout.restore(try fixture("quote",CommerceQuote.self))
    var requested = false
    do { try await cart.mutate { requested = true; return value }; XCTFail() } catch let e as CommerceFailure { XCTAssertEqual(e.status,409) }
    XCTAssertFalse(requested); checkout.reset()
    do { try await cart.mutate { cart.reset(); return value }; XCTFail() } catch is CancellationError {}
    XCTAssertNil(cart.value)
  }
  func testCartFailureKeepsExistingCartAndInvalidatesReview() async throws {
    let checkout = CheckoutFlow(), cart = CartStore(client:try client(),checkout:checkout)
    let value = try fixture("cart",CommerceCart.self); cart.accept(value)
    try await checkout.review { try fixture("quote",CommerceQuote.self) }
    do { try await cart.mutate { XCTAssertNil(checkout.quote); throw URLError(.timedOut) }; XCTFail() } catch {}
    XCTAssertEqual(cart.value?.id,value.id)
  }
  func testPendingCheckoutRestoresBeforeUnrelatedAccountReadFails() async throws {
    let quote = try fixture("quote",CommerceQuote.self), customer = try fixture("customer",CustomerAccount.self)
    let attempt = CheckoutAttempt(customerID:customer.id,quote:quote,key:"existing-key")
    let attempts = MemoryCredential(String(data:try JSONEncoder().encode([customer.id: attempt]),encoding:.utf8))
    let session = ShoppingSession(client:try client([.success(try auth()),.failure(URLError(.notConnectedToInternet))],attempts:attempts))
    try await session.account.login("fixture",password:"test")
    do { try await session.reload(); XCTFail() } catch {}
    XCTAssertTrue(session.checkout.locked); XCTAssertEqual(session.checkout.quote?.id,quote.id)
  }
  func testActionConfirmationSurvivesFollowupFailure() async throws {
    let api = try client([.success(auth()), .success(HTTPResult(status: 200, body: data("detail"))), .failure(URLError(.notConnectedToInternet))])
    let session = ShoppingSession(client: api)
    try await session.account.login("fixture", password: "test")
    try await session.checkout.review { try self.fixture("quote", CommerceQuote.self) }
    let ok = await session.perform {
      try await session.actions.place { _ in session.feedback.setNotice("Confirmed") }
    }
    XCTAssertFalse(ok); XCTAssertEqual(session.feedback.notice, "Confirmed")
    XCTAssertNotNil(session.orders.detail); XCTAssertEqual(session.checkout.phase, .completed)
    XCTAssertNotNil(session.feedback.failure)
  }
  func testActionStopsFollowupWhenConfirmationChangesSession() async throws {
    let api = try client([.success(auth()), .success(HTTPResult(status: 200, body: data("detail")))])
    let session = ShoppingSession(client: api)
    try await session.account.login("fixture", password: "test")
    try await session.checkout.review { try self.fixture("quote", CommerceQuote.self) }
    do { try await session.actions.place { _ in session.account.reset() }; XCTFail() }
    catch { XCTAssertTrue(error is CancellationError) }
    XCTAssertNil(session.orders.detail)
  }
  func testGuestDeliveryActionDoesNotReadAuthenticatedCart() async throws {
    let session = ShoppingSession(client: try client([.success(HTTPResult(status: 200, body: data("coverage")))]))
    try await session.actions.save(pin: DeliveryPin(latitude: 30, longitude: 31), address: "Guest", building: "", floor: "", apartment: "", instructions: "")
    XCTAssertEqual(session.delivery.state.guestAddress, "Guest")
    XCTAssertNil(session.cart.value)
    try await session.actions.assistantSettled()
  }
  func testLoginPublishesAuthenticationBeforeRecoveryFailure() async throws {
    let session = ShoppingSession(client: try client([.success(auth()), .failure(URLError(.notConnectedToInternet))]))
    var authenticated = false
    do { try await session.actions.login("fixture", password: "test") { authenticated = true }; XCTFail() } catch {}
    XCTAssertTrue(authenticated); XCTAssertNotNil(session.account.customer)
  }
  func testLogoutHookPrecedesAccountCleanup() async throws {
    let session = ShoppingSession(client: try client([.success(HTTPResult(status: 204, body: Data()))]))
    session.account.accept(try fixture("customer", CustomerAccount.self))
    var hook = false
    try await session.actions.logout { hook = true; XCTAssertNotNil(session.account.customer) }
    XCTAssertTrue(hook); XCTAssertNil(session.account.customer)
  }

  func testAssistantProposalStopsDeliveryFollowupAfterIdentityChange() async throws {
    let api = try client([.success(auth()), .success(HTTPResult(status: 200, body: Data("{}".utf8))), .success(HTTPResult(status: 200, body: data("cart")))])
    let session = ShoppingSession(client: api)
    try await session.account.login("fixture", password: "test")
    session.cart.onChange = { session.cart.onChange = nil; session.account.reset() }
    do { try await session.actions.applyProposal("70000000-0000-0000-0000-000000000002", location: "stale"); XCTFail() }
    catch { XCTAssertTrue(error is CancellationError) }
    XCTAssertNil(session.cart.value)
  }
  func testLoginCallbackCannotRecoverAnotherSession() async throws {
    let session = ShoppingSession(client: try client([.success(auth())]))
    do { try await session.actions.login("fixture", password: "test") { session.account.reset() }; XCTFail() }
    catch { XCTAssertTrue(error is CancellationError) }
  }

  func testDeliveryActionInvalidatesQuoteAndRefreshesCart() async throws {
    let api = try client([.success(auth()), .success(HTTPResult(status: 200, body: data("locations"))),
      .success(HTTPResult(status: 200, body: data("availability"))), .success(HTTPResult(status: 200, body: data("coverage"))),
      .success(HTTPResult(status: 200, body: data("cart")))])
    let session = ShoppingSession(client: api)
    try await session.account.login("fixture", password: "test")
    try await session.delivery.refresh(client: api)
    try await session.checkout.review { try self.fixture("quote", CommerceQuote.self) }
    try await session.actions.choose(session.delivery.state.locations[0].id)
    XCTAssertNil(session.checkout.quote); XCTAssertNotNil(session.cart.value)
  }

  func testRuntimeOwnsSettingsAndSingleIdentityReset() throws {
    let settings = AppSettingsStore(locale: "ar")
    let runtime = ShoppingRuntime(client: try client(), settings: settings)
    XCTAssertTrue(runtime.settings === settings); XCTAssertEqual(runtime.catalog.locale, "ar")
    runtime.session.assistant.draft = "Private message"
    runtime.session.navigation.open("order")
    runtime.session.orders.show(try fixture("detail", CustomerOrderDetail.self))
    var orderChanges = 0; runtime.session.orders.onChange = { orderChanges += 1 }
    runtime.session.account.reset()
    XCTAssertEqual(orderChanges, 1); XCTAssertNil(runtime.session.orders.detail)
    XCTAssertEqual(runtime.session.assistant.draft, ""); XCTAssertEqual(settings.locale, "ar")
  }

}
