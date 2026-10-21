import XCTest
@testable import RocentoCore

final class ShoppingWorkflowsTests: XCTestCase {
  @MainActor func testGuestAndRecoveryOrdering() async throws {
    var calls: [String] = []; var signedIn = false
    let workflows = ShoppingWorkflows(restoreAccount: { calls.append("account"); return signedIn },
      recoverySteps: ["checkout", "delivery", "cart", "orders"].map { name in { calls.append(name) } },
      revision: { 0 }, saveItem: { _ in }, refreshWishlist: {})
    try await workflows.recover(); XCTAssertEqual(calls, ["account"])
    signedIn = true; calls = []
    try await workflows.recover(); XCTAssertEqual(calls, ["account", "checkout", "delivery", "cart", "orders"])
  }
  @MainActor func testIdentityChangeStopsRecoveryAndWishlistFollowup() async {
    var generation = 0; var followups = 0
    let workflows = ShoppingWorkflows(restoreAccount: { true },
      recoverySteps: [{ generation += 1 }, { followups += 1 }], revision: { generation },
      saveItem: { _ in generation += 1 }, refreshWishlist: { followups += 1 })
    do { try await workflows.recover(); XCTFail("Expected cancellation") } catch { XCTAssertTrue(error is CancellationError) }
    do { try await workflows.saveForLater("product"); XCTFail("Expected cancellation") } catch { XCTAssertTrue(error is CancellationError) }
    XCTAssertEqual(followups, 0)
  }
  @MainActor func testFailedRecoveryCanBeRetried() async throws {
    var fail = true; var content = 0
    let workflows = ShoppingWorkflows(restoreAccount: { true },
      recoverySteps: [{ if fail { throw CommerceFailure(503,"Offline") } }, { content += 1 }],
      revision: { 0 }, saveItem: { _ in }, refreshWishlist: {})
    do { try await workflows.recover(); XCTFail("Expected failure") } catch {}
    XCTAssertEqual(content, 0); fail = false
    try await workflows.recover(); XCTAssertEqual(content, 1)
  }
}
