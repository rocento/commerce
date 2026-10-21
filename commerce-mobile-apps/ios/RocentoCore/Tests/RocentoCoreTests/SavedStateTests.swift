import XCTest
@testable import RocentoCore

private actor SavedGate {
  private var continuation: CheckedContinuation<Void, Never>?
  func wait() async { await withCheckedContinuation { continuation = $0 } }
  func release() { continuation?.resume(); continuation = nil }
}
private actor SavedClient: WishlistServing, NotificationsServing {
  var ids = (0..<25).map(String.init)
  var fail = false
  var gate: SavedGate?
  var started: XCTestExpectation?
  var productReads: [String] = []
  func reads() -> [String] { productReads }
  func pause(_ gate: SavedGate, _ started: XCTestExpectation) { self.gate = gate; self.started = started }
  func setFail(_ value: Bool) { fail = value }
  func wishlist() async throws -> [String] { if let gate { started?.fulfill(); await gate.wait() }; return ids }
  func product(id: String, locale: String) async throws -> Product {
    productReads.append(id)
    if fail { throw URLError(.notConnectedToInternet) }
    if id == "0" { throw CommerceFailure(404, "gone") }
    return try JSONDecoder().decode(Product.self, from: Data("{\"id\":\"\(id)\",\"name\":\"\(locale)\",\"description\":\"\",\"price\":\"1\",\"currency\":\"USD\",\"in_stock\":true}".utf8))
  }
  func saveProduct(_ id: String, saved: Bool) async throws {
    if let gate { started?.fulfill(); await gate.wait() }
    if fail { throw URLError(.notConnectedToInternet) }
  }
  func orders(offset: Int) async throws -> [CustomerOrder] { [CustomerOrder(id: offset == 0 ? "a" : "b", number: 1, status: "placed", total: "1", currency: "USD", created_at: "2026-10-01")] }
  func order(_ id: String) async throws -> CustomerOrderDetail {
    if let gate { started?.fulfill(); await gate.wait() }
    if fail { throw URLError(.notConnectedToInternet) }
    let order = CustomerOrder(id: id, number: 1, status: "placed", total: "1", currency: "USD", created_at: "2026-10-01")
    let event = CustomerOrderDetail.OrderHistory(id: "event", status: "placed", created_at: "2026-10-01")
    return CustomerOrderDetail(order: order, history: [event, event])
  }
}
@MainActor final class SavedStateTests: XCTestCase {
  func testWishlistPaginationReusesResolvedProductsButRefreshReloadsThem() async throws {
    let client = SavedClient()
    let paged = WishlistStore(client: client)
    try await paged.load(locale: "en")
    try await paged.load(locale: "en", more: true)
    var reads = await client.reads()
    XCTAssertEqual(reads.count, 25)
    XCTAssertEqual(reads.filter { $0 == "0" }.count, 1, "Unavailable products remain resolved until refresh")
    try await paged.load(locale: "en")
    reads = await client.reads(); XCTAssertEqual(reads.count, 49)
    try await paged.load(locale: "ar", more: true)
    reads = await client.reads(); XCTAssertEqual(reads.count, 74)
    XCTAssertTrue(paged.state.products.values.allSatisfy { $0.name == "ar" })
  }
  func testWishlistMissingProductsRemainRemovableAndPagingAdvances() async throws {
    let store = WishlistStore(client: SavedClient())
    try await store.load(locale: "en"); XCTAssertEqual(store.state.resolved.count, 24); XCTAssertNil(store.state.products["0"])
    try await store.load(locale: "en", more: true); XCTAssertEqual(store.state.resolved.count, 25)
    try await store.save("0", saved: false); XCTAssertFalse(store.state.ids.contains("0"))
  }
  func testFailedWishlistReadAndMutationPreserveSnapshot() async throws {
    let client = SavedClient(), store = WishlistStore(client: client)
    try await store.load(locale: "en"); await client.setFail(true)
    do { try await store.load(locale: "en"); XCTFail() } catch { }
    XCTAssertEqual(store.state.products.count, 23); XCTAssertTrue(store.state.failed)
    do { try await store.save("1", saved: false); XCTFail() } catch { }
    XCTAssertTrue(store.state.ids.contains("1"))
    do { try await store.load(locale: "ar"); XCTFail() } catch { }
    XCTAssertTrue(store.state.products.isEmpty)
  }
  func testWishlistResetRejectsLateRead() async throws {
    let client = SavedClient(), gate = SavedGate(), started = expectation(description: "read")
    await client.pause(gate, started); let store = WishlistStore(client: client)
    let request = Task { try await store.load(locale: "en") }; await fulfillment(of: [started]); store.reset(); await gate.release()
    do { try await request.value; XCTFail() } catch is CancellationError { }
    XCTAssertTrue(store.state.ids.isEmpty)
  }
  func testWishlistResetRejectsLateMutation() async throws {
    let client = SavedClient(), gate = SavedGate(), started = expectation(description: "save")
    await client.pause(gate, started); let store = WishlistStore(client: client)
    let request = Task { try await store.save("private", saved: true) }; await fulfillment(of: [started]); store.reset(); await gate.release()
    do { try await request.value; XCTFail() } catch is CancellationError { }
    XCTAssertTrue(store.state.ids.isEmpty)
  }
  func testNotificationReadMarkersAreScopedAndRestored() async throws {
    let client = SavedClient(), preferences = MemoryNotificationPreferences(), store = NotificationsStore(client: client, preferences: preferences)
    try await store.refresh(owner: "alice"); XCTAssertEqual(store.state.events.count, 1)
    store.mark(["a:event", "unknown"]); XCTAssertTrue(store.state.unread.isEmpty)
    try await store.refresh(owner: "bob"); XCTAssertEqual(store.state.unread.count, 1)
    let restored = NotificationsStore(client: client, preferences: preferences); try await restored.refresh(owner: "alice")
    XCTAssertTrue(restored.state.unread.isEmpty); XCTAssertEqual(restored.state.read.count, 1)
  }
  func testFailedInboxPagePreservesRowsAndOffset() async throws {
    let client = SavedClient(), store = NotificationsStore(client: client, preferences: MemoryNotificationPreferences())
    try await store.refresh(owner: "alice"); await client.setFail(true)
    do { try await store.refresh(owner: "alice", more: true); XCTFail() } catch { }
    XCTAssertEqual(store.state.events.count, 1); XCTAssertEqual(store.state.offset, 1)
    await client.setFail(false); try await store.refresh(owner: "alice", more: true)
    XCTAssertEqual(store.state.events.count, 2); XCTAssertEqual(store.state.offset, 2)
  }
  func testInboxResetDiscardsLateDetail() async throws {
    let client = SavedClient(), gate = SavedGate(), started = expectation(description: "detail")
    await client.pause(gate, started); let store = NotificationsStore(client: client, preferences: MemoryNotificationPreferences())
    let request = Task { try await store.refresh(owner: "alice") }; await fulfillment(of: [started]); store.reset(); await gate.release()
    do { try await request.value; XCTFail() } catch is CancellationError { }
    XCTAssertTrue(store.state.events.isEmpty); XCTAssertNil(store.state.owner)
  }
  func testPausedInboxPreservesPreferenceWithoutFetching() async throws {
    let preferences = MemoryNotificationPreferences(), store = NotificationsStore(client: SavedClient(), preferences: preferences)
    store.setEnabled(false); try await store.refresh(owner: "alice"); XCTAssertFalse(store.state.loaded)
    let restored = NotificationsStore(client: SavedClient(), preferences: preferences); XCTAssertFalse(restored.state.enabled)
    restored.setEnabled(true); try await restored.refresh(owner: "alice"); XCTAssertTrue(restored.state.loaded)
  }
}
