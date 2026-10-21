import XCTest
@testable import RocentoCore

private actor OrderGate<T: Sendable> {
  private var continuation: CheckedContinuation<T, Never>?
  func wait(_ started: XCTestExpectation) async -> T {
    await withCheckedContinuation { continuation = $0; started.fulfill() }
  }
  func release(_ value: T) { continuation?.resume(returning: value); continuation = nil }
}
final class NavigationOrderTests: XCTestCase {
  private func order(_ id: String) -> CustomerOrder { CustomerOrder(id: id, number: 1, status: "placed", total: "1", currency: "USD", created_at: "2026-10-01") }
  private func detail(_ id: String) -> CustomerOrderDetail { CustomerOrderDetail(order: order(id), history: []) }
  @MainActor func testPagingUsesRawOffsetsAndStopsAtEmptyPage() async throws {
    var offsets: [Int] = []
    let store = OrderStore(list: { offset in offsets.append(offset); return offset == 0 ? [self.order("a"), self.order("a")] : [] }, fetch: { self.detail($0) })
    try await store.refresh(); try await store.refresh(more: true); try await store.refresh(more: true)
    XCTAssertEqual(offsets, [0, 2]); XCTAssertEqual(store.orders.count, 1); XCTAssertFalse(store.hasMore)
  }
  @MainActor func testFailurePreservesHistoryAndRetryRecovers() async throws {
    var failing = false
    let store = OrderStore(list: { _ in if failing { throw URLError(.notConnectedToInternet) }; return [self.order("a")] }, fetch: { self.detail($0) })
    try await store.refresh(); failing = true
    do { try await store.refresh(); XCTFail() } catch {}
    XCTAssertTrue(store.failed); XCTAssertFalse(store.loading); XCTAssertEqual(store.orders.count, 1)
    failing = false; try await store.refresh(); XCTAssertFalse(store.failed)
  }
  @MainActor func testLateDetailCannotReplaceSelectionOrCheckout() async throws {
    let gate = OrderGate<CustomerOrderDetail>(); let started = expectation(description: "detail started")
    let store = OrderStore(list: { _ in [] }, fetch: { id in id == "old" ? await gate.wait(started) : self.detail(id) })
    let pending = Task { try await store.track("old") }
    await fulfillment(of: [started]); try await store.track("new"); await gate.release(detail("old"))
    do { try await pending.value; XCTFail() } catch is CancellationError {}
    XCTAssertEqual(store.detail?.order.id, "new")
    let nextGate = OrderGate<CustomerOrderDetail>(); let nextStarted = expectation(description: "next detail")
    let next = OrderStore(list: { _ in [] }, fetch: { _ in await nextGate.wait(nextStarted) })
    let read = Task { try await next.track("old") }; await fulfillment(of: [nextStarted])
    next.show(detail("checkout")); await nextGate.release(detail("old"))
    do { try await read.value; XCTFail() } catch is CancellationError {}
    XCTAssertEqual(next.detail?.order.id, "checkout")
  }
  @MainActor func testResetRejectsHistoryAndNewDetailFailureClearsOldContent() async throws {
    let gate = OrderGate<[CustomerOrder]>(); let started = expectation(description: "history")
    let store = OrderStore(list: { _ in await gate.wait(started) }, fetch: { _ in throw URLError(.notConnectedToInternet) })
    let pending = Task { try await store.refresh() }; await fulfillment(of: [started]); store.reset(); await gate.release([order("a")])
    do { _ = try await pending.value; XCTFail() } catch is CancellationError {}
    XCTAssertTrue(store.orders.isEmpty); store.show(detail("old"))
    do { try await store.track("new"); XCTFail() } catch {}
    XCTAssertNil(store.detail); XCTAssertEqual(store.selectedID, "new"); XCTAssertTrue(store.detailFailed)
  }
  @MainActor func testBackReturnsToHistoryAndDismissesCheckout() {
    let nav = NavigationStore(); nav.selectTab("account"); nav.open("orders"); nav.open("order"); nav.back()
    XCTAssertEqual(nav.panel, "orders"); nav.selectTab("cart"); nav.openCart("checkout"); nav.back()
    XCTAssertEqual(nav.tab, "cart"); XCTAssertNil(nav.cartPanel); nav.back(); XCTAssertEqual(nav.tab, "home"); XCTAssertFalse(nav.back())
  }
  @MainActor func testCustomerResetClearsRoutesAndNotificationReturn() {
    let nav = NavigationStore(); nav.selectTab("account"); nav.open("notification-order"); nav.back(); XCTAssertEqual(nav.panel, "notifications")
    nav.presentAssistant(true); nav.resetCustomerRoutes(); XCTAssertNil(nav.panel); XCTAssertFalse(nav.assistantPresented); XCTAssertEqual(nav.tab, "account")
  }
}
