import XCTest
@testable import RocentoCore

private actor InboxReadProbe: NotificationsServing {
  let started: XCTestExpectation
  var pending: [CheckedContinuation<Void, Never>] = []
  var released = false
  var active = 0
  var peak = 0
  var reads = 0
  init(_ started: XCTestExpectation) { self.started = started }
  func orders(offset: Int) async throws -> [CustomerOrder] {
    (0..<9).map { CustomerOrder(id: String($0), number: Int64($0), status: "placed", total: "1", currency: "USD", created_at: "2026-10-15") }
  }
  func order(_ id: String) async throws -> CustomerOrderDetail {
    reads += 1; active += 1; peak = max(peak, active)
    defer { active -= 1 }
    if !released {
      if active == 4 { started.fulfill() }
      await withCheckedContinuation { pending.append($0) }
    }
    try Task.checkCancellation()
    let order = CustomerOrder(id: id, number: Int64(id)!, status: "placed", total: "1", currency: "USD", created_at: "2026-10-15")
    return CustomerOrderDetail(order: order, history: [])
  }
  func release() { released = true; pending.forEach { $0.resume() }; pending = [] }
  func metrics() -> (Int, Int) { (peak, reads) }
}

@MainActor final class ConcurrentReadTests: XCTestCase {
  func testInboxLoadsFourDetailsAtATimeAndPreservesServerOrder() async throws {
    let started = expectation(description: "four overlapping reads")
    let client = InboxReadProbe(started)
    let store = NotificationsStore(client: client, preferences: MemoryNotificationPreferences())
    let request = Task { try await store.refresh(owner: "alice") }
    await fulfillment(of: [started], timeout: 2)
    await client.release()
    try await request.value
    let (peak, reads) = await client.metrics()
    XCTAssertEqual(peak, 4); XCTAssertEqual(reads, 9)
    XCTAssertEqual(store.state.details.map(\.order.id), (0..<9).map(String.init))
    XCTAssertEqual(store.state.offset, 9)
  }
  func testResetDuringConcurrentReadsDoesNotFetchAnotherPageOrPublishPrivateData() async throws {
    let started = expectation(description: "four overlapping reads")
    let client = InboxReadProbe(started)
    let store = NotificationsStore(client: client, preferences: MemoryNotificationPreferences())
    let request = Task { try await store.refresh(owner: "alice") }
    await fulfillment(of: [started], timeout: 2)
    store.reset(); await client.release()
    do { try await request.value; XCTFail("Old account reads must be discarded") } catch is CancellationError { }
    let (_, reads) = await client.metrics()
    XCTAssertEqual(reads, 4)
    XCTAssertTrue(store.state.details.isEmpty); XCTAssertNil(store.state.owner)
  }
}
