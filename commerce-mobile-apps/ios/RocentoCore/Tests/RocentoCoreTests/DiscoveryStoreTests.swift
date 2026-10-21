import XCTest
@testable import RocentoCore

private actor DiscoveryGate {
  var continuation: CheckedContinuation<Void, Never>?
  var open = false
  func wait() async { if !open { await withCheckedContinuation { continuation = $0 } } }
  func release() { open = true; continuation?.resume(); continuation = nil }
}
private func discoveryProduct(_ id: String) -> Product {
  try! JSONDecoder().decode(Product.self, from: Data("{\"id\":\"\(id)\",\"name\":\"\(id)\",\"description\":\"\",\"price\":\"1\",\"currency\":\"USD\",\"in_stock\":true,\"product_type\":\"simple\"}".utf8))
}
private struct DiscoveryCatalog: CatalogServing {
  var gate: DiscoveryGate?
  var started: XCTestExpectation?
  func categories(locale: String) async throws -> [RocentoCore.Category] { [] }
  func products(category: String?, locale: String) async throws -> [Product] { [discoveryProduct(locale)] }
  func product(id: String, locale: String) async throws -> Product {
    if id == "old" { started?.fulfill(); await gate?.wait() }
    return discoveryProduct(id)
  }
  func attributes(locale: String) async throws -> [CatalogAttribute] { [] }
  func browse(category: String, filters: CatalogFilters, offset: Int, locale: String) async throws -> CatalogPage {
    if category == "old" { started?.fulfill(); await gate?.wait() }
    let ids = offset == 0 ? [category, category] : [category, "next"]
    return CatalogPage(hits: ids.map(discoveryProduct), total: 4, facets: nil)
  }
}
private struct DiscoveryAssistant: AssistantServing {
  var gate: DiscoveryGate?
  var started: XCTestExpectation?
  var fail = false
  func setLocale(_ value: String) async {}
  func streamAssistant(_ input: AssistantInput, onEvent: @Sendable (AssistantEvent) async throws -> Void) async throws {
    started?.fulfill(); await gate?.wait()
    if fail { throw CommerceFailure(401, "Sign in") }
    for (sequence, type) in ["message.delta", "done"].enumerated() {
      let data = Data("{\"version\":\"1\",\"request_id\":\"\(input.request_id)\",\"sequence\":\(sequence),\"type\":\"\(type)\",\"text\":\"Review\",\"code\":\"open_checkout\",\"response_source\":\"R\"}".utf8)
      try await onEvent(JSONDecoder().decode(AssistantEvent.self, from: data))
    }
  }
}
@MainActor final class DiscoveryStoreTests: XCTestCase {
  func testReplacingProductKeepsNavigationPresentedUntilVariantArrives() async throws {
    let gate = DiscoveryGate(), started = expectation(description: "variant started")
    let store = CatalogStore(catalog: DiscoveryCatalog(gate: gate, started: started))
    try await store.product("parent")
    let pending = Task { try await store.product("old") }
    await fulfillment(of: [started])
    XCTAssertEqual(store.selectedProduct?.id, "parent")
    await gate.release(); try await pending.value
    XCTAssertEqual(store.selectedProduct?.id, "old")
  }
  func testLateProductCannotReopenDismissedOrReplaceNewSelection() async throws {
    let gate = DiscoveryGate(), started = expectation(description: "product started")
    let store = CatalogStore(catalog: DiscoveryCatalog(gate: gate, started: started))
    let pending = Task { try await store.product("old") }
    await fulfillment(of: [started]); store.dismissProduct(); try await store.product("new"); await gate.release()
    do { try await pending.value; XCTFail("stale selection") } catch is CancellationError {} catch { XCTFail("\(error)") }
    XCTAssertEqual(store.selectedProduct?.id, "new"); XCTAssertTrue(store.variants.isEmpty)
  }
  func testOldCategoryResponseDoesNotReplaceNewResults() async {
    let gate = DiscoveryGate(), started = expectation(description: "search started")
    let store = CatalogStore(catalog: DiscoveryCatalog(gate: gate, started: started))
    let pending = Task { await store.category("old") }; await fulfillment(of: [started])
    await store.category("new"); await gate.release(); await pending.value
    XCTAssertEqual(store.categoryProducts.map(\.id), ["new"])
    await store.browseCategory(more: true)
    XCTAssertEqual(store.categoryProducts.map(\.id), ["new", "next"]); XCTAssertFalse(store.categoryHasMore)
  }
  func testLocaleChangeClearsOldCatalogAndProduct() async throws {
    let store = CatalogStore(catalog: DiscoveryCatalog()); try await store.load(collectionIDs: ["home"]); try await store.product("a")
    store.changeLocale("ar"); XCTAssertTrue(store.products.isEmpty); XCTAssertNil(store.selectedProduct)
    try await store.load(collectionIDs: ["home"]); XCTAssertEqual(store.products.first?.id, "ar")
  }
  func testAssistantResetDiscardsLateEventsAndSettlement() async {
    let gate = DiscoveryGate(), started = expectation(description: "stream started")
    let store = AssistantStore(client: DiscoveryAssistant(gate: gate, started: started))
    store.send("review", locale: "en", settled: { XCTFail("old account refresh") }, checkout: { XCTFail("old navigation") })
    await fulfillment(of: [started]); store.reset(); await gate.release()
    for _ in 0..<10 { await Task.yield() }
    XCTAssertTrue(store.turns.isEmpty); XCTAssertFalse(store.busy)
  }
  func testAssistantStopsWithoutReplayAndRefreshesBeforeUnlocking() async {
    let gate = DiscoveryGate(), started = expectation(description: "stream started"), settled = expectation(description: "settled")
    let store = AssistantStore(client: DiscoveryAssistant(gate: gate, started: started))
    store.send("review", locale: "en", settled: { XCTAssertTrue(store.busy); settled.fulfill() }, checkout: { XCTFail("cancelled checkout") })
    await fulfillment(of: [started]); store.stop(); await gate.release(); await fulfillment(of: [settled])
    for _ in 0..<10 { await Task.yield() }
    XCTAssertFalse(store.busy)
  }
  func testAssistantValidationAndAuthenticationFailure() async {
    let store = AssistantStore(client: DiscoveryAssistant(fail: true)), settled = expectation(description: "settled")
    store.send(" ", locale: "en", settled: {}, checkout: {}); XCTAssertTrue(store.turns.isEmpty)
    store.send(String(repeating: "x", count: 4001), locale: "en", settled: {}, checkout: {}); XCTAssertTrue(store.turns.isEmpty)
    store.send("hello", locale: "en", settled: { settled.fulfill() }, checkout: { XCTFail("failed checkout") })
    await fulfillment(of: [settled]); XCTAssertTrue(store.signInRequired); XCTAssertTrue(store.turns[0].interrupted)
  }
  func testUncertainProposalChecksStatusWithoutRepeatingMutation() async throws {
    var applied = false, mutations = 0, settled = 0
    let store = AssistantProposalStore {
      try JSONDecoder().decode(AssistantJSON.self, from: Data("{\"can_apply\":true,\"applied\":\(applied),\"expires_at\":\"2099-01-01T00:00:00Z\"}".utf8))
    }
    await store.reload { settled += 1 }
    await store.apply(locked: false, operation: { _ in mutations += 1; throw URLError(.networkConnectionLost) }, settled: { settled += 1 })
    await store.apply(locked: false, operation: { _ in mutations += 1 }, settled: { settled += 1 })
    XCTAssertEqual(mutations, 1); XCTAssertTrue(store.pending)
    applied = true; await store.reload { settled += 1 }
    XCTAssertFalse(store.pending); XCTAssertFalse(store.canApply); XCTAssertEqual(settled, 1)
  }
  func testProductPromptResetDiscardsLateResults() async {
    let store = ProductPromptStore(), gate = DiscoveryGate(), started = expectation(description: "prompt started")
    let old = Task { await store.load { started.fulfill(); await gate.wait(); return [discoveryProduct("old")] } }
    await fulfillment(of: [started]); store.reset()
    await store.load { [discoveryProduct("new")] }; store.select("new", enabled: true)
    await gate.release(); await old.value
    XCTAssertEqual(store.products.map(\.id), ["new"]); XCTAssertEqual(store.selected, ["new"])
  }

  func testStopDuringSettlementSuppressesCheckoutNavigation() async {
    let store = AssistantStore(client: DiscoveryAssistant()), gate = DiscoveryGate(), settling = expectation(description: "settling"), finished = expectation(description: "finished")
    store.send("review", locale: "en", settled: { settling.fulfill(); await gate.wait() }, checkout: { XCTFail("stopped navigation") })
    await fulfillment(of: [settling]); store.onChange = { if !store.busy { finished.fulfill() } }; store.stop(); await gate.release(); await fulfillment(of: [finished])
    store.onChange = nil
  }

}
