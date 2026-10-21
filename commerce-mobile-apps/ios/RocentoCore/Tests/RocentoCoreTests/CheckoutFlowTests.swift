import XCTest
@testable import RocentoCore

@MainActor final class CheckoutFlowTests: XCTestCase {
  private func fixture<T: Decodable>(_ key: String, _: T.Type) throws -> T {
    let data = try Data(contentsOf: Bundle.module.url(forResource: "commerce-flow", withExtension: "json")!)
    let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
    return try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: json[key]!))
  }
  func testReviewDoesNotSubmitAndInvalidationClearsOptions() async throws {
    let flow = CheckoutFlow()
    try await flow.loadOptions { try fixture("options", FulfillmentOptions.self) }
    try await flow.review { try fixture("quote", CommerceQuote.self) }
    XCTAssertEqual(flow.phase, .ready)
    flow.invalidate()
    XCTAssertEqual(flow.phase, .editing); XCTAssertNil(flow.quote); XCTAssertNil(flow.options)
  }
  func testPendingPickupPreservesServerItemsDestinationAndWindowAcrossEncoding() async throws {
    let quote = try fixture("quote", CommerceQuote.self)
    var payload = try JSONSerialization.jsonObject(with: JSONEncoder().encode(quote)) as! [String: Any]
    var snapshot = payload["snapshot"] as! [String: Any]
    snapshot["location"] = ["formatted_address": "Original pickup address", "custom_label": "Original branch", "location_method": "pickup"]
    snapshot["items"] = [["product_id": "original-product", "name": "Reviewed item", "quantity": 2, "price": "12.50", "line_total": "25.00"]]
    snapshot["fulfillment_plan"] = ["method": "pickup", "groups": [["source_id": "original-source", "source_name": "Original branch", "schedule_id": "original-slot", "starts_at": "2026-10-15T12:00:00Z", "ends_at": "2026-10-15T13:00:00Z", "timezone": "Africa/Cairo"]]]
    payload["snapshot"] = snapshot
    let reviewed = try JSONDecoder().decode(CommerceQuote.self, from: JSONSerialization.data(withJSONObject: payload))
    let persisted = CheckoutAttempt(customerID: "alice", quote: reviewed, key: "original-idempotency-key")
    let restored = try JSONDecoder().decode(CheckoutAttempt.self, from: JSONEncoder().encode(persisted))
    let flow = CheckoutFlow()
    flow.restore(restored.quote)
    let unrelatedDeliveryForm = DeliveryForm(checkout: flow)
    XCTAssertEqual(unrelatedDeliveryForm.state.method, "delivery")
    XCTAssertEqual(flow.phase, .uncertain)
    XCTAssertEqual(flow.quote?.snapshot.method, "pickup")
    XCTAssertEqual(flow.quote?.snapshot.location?.formatted_address, "Original pickup address")
    XCTAssertEqual(flow.quote?.snapshot.items?.first?.name, "Reviewed item")
    XCTAssertEqual(flow.quote?.snapshot.items?.first?.quantity, 2)
    XCTAssertEqual(flow.quote?.snapshot.fulfillment_plan?.groups.first?.starts_at, "2026-10-15T12:00:00Z")
    XCTAssertEqual(restored.key, "original-idempotency-key")
    _ = try await flow.place({ retry in
      XCTAssertEqual(retry.snapshot.method, "pickup")
      XCTAssertEqual(retry.snapshot.location?.custom_label, "Original branch")
      return try self.fixture("detail", CustomerOrderDetail.self)
    }, pending: { restored.quote })
  }
  func testLegacyPendingQuoteRemainsRecoverableWithoutInventingDestination() throws {
    let legacy = try fixture("quote", CommerceQuote.self)
    let restored = try JSONDecoder().decode(CommerceQuote.self, from: JSONEncoder().encode(legacy))
    let flow = CheckoutFlow(); flow.restore(restored)
    XCTAssertEqual(flow.phase, .uncertain)
    XCTAssertNil(flow.quote?.snapshot.location)
    XCTAssertNil(flow.quote?.snapshot.fulfillment_plan)
    XCTAssertNil(flow.quote?.snapshot.method)
    XCTAssertEqual(flow.quote?.id, legacy.id)
  }
  func testGiftDraftValidationInvalidationAndRecovery() async throws {
    let flow = CheckoutFlow(); let quote = try fixture("quote", CommerceQuote.self)
    flow.setGiftMessage("For you")
    try await flow.loadOptions { try fixture("options", FulfillmentOptions.self) }
    XCTAssertEqual(flow.giftMessage, "For you")
    try await flow.review { quote }
    flow.setGiftMessage("Changed"); XCTAssertNil(flow.quote)
    flow.invalidate(); XCTAssertEqual(flow.giftMessage, "Changed")
    flow.setGiftMessage(String(repeating: "ع", count: 251))
    do { try await flow.review { XCTFail("Oversize message sent"); return quote }; XCTFail() } catch is CommerceFailure {}
    flow.setGiftMessage(String(repeating: "ع", count: 250)); XCTAssertTrue(flow.giftMessageValid)
    var saved = try JSONSerialization.jsonObject(with: JSONEncoder().encode(quote)) as! [String: Any]
    var snapshot = saved["snapshot"] as! [String: Any]; snapshot["gift_message"] = "Saved gift"; saved["snapshot"] = snapshot
    flow.restore(try JSONDecoder().decode(CommerceQuote.self, from: JSONSerialization.data(withJSONObject: saved)))
    flow.setGiftMessage("Cannot change"); XCTAssertEqual(flow.giftMessage, "Saved gift")
    flow.reset(); XCTAssertEqual(flow.giftMessage, "")
  }
  func testDuplicateConfirmationAndCompletedState() async throws {
    let flow = CheckoutFlow(); let quote = try fixture("quote", CommerceQuote.self)
    let detail = try fixture("detail", CustomerOrderDetail.self)
    try await flow.review { quote }
    var calls = 0
    let result = try await flow.place({ _ in
      calls += 1
      XCTAssertEqual(flow.phase, .submitting)
      flow.invalidate(); XCTAssertTrue(flow.locked)
      do { _ = try await flow.place({ _ in calls += 1; return detail }, pending: { nil }); XCTFail("Duplicate accepted") } catch {}
      return detail
    }, pending: { nil })
    XCTAssertEqual(result.order.id, detail.order.id); XCTAssertEqual(calls, 1)
    XCTAssertEqual(flow.phase, .completed); XCTAssertNil(flow.quote)
  }
  func testUncertainRetryPreservesReviewedQuote() async throws {
    let flow = CheckoutFlow(); let quote = try fixture("quote", CommerceQuote.self)
    try await flow.review { quote }
    do { _ = try await flow.place({ _ in throw URLError(.networkConnectionLost) }, pending: { quote }); XCTFail() } catch {}
    flow.invalidate(); flow.edit()
    XCTAssertEqual(flow.phase, .uncertain); XCTAssertEqual(flow.quote?.id, quote.id)
    _ = try await flow.place({ reviewed in
      XCTAssertEqual(reviewed.id, quote.id)
      return try self.fixture("detail", CustomerOrderDetail.self)
    }, pending: { nil })
    XCTAssertEqual(flow.phase, .completed)
  }
  func testStorageFailureKeepsRecoveryLocked() async throws {
    let flow = CheckoutFlow(); let quote = try fixture("quote", CommerceQuote.self)
    flow.restore(quote)
    do { _ = try await flow.place({ _ in throw URLError(.timedOut) }, pending: { throw URLError(.cannotOpenFile) }); XCTFail() } catch {}
    XCTAssertEqual(flow.phase, .uncertain); XCTAssertEqual(flow.quote?.id, quote.id)
  }
  func testDefinitiveRejectionReturnsToEditing() async throws {
    let flow = CheckoutFlow(); flow.restore(try fixture("quote", CommerceQuote.self))
    do { _ = try await flow.place({ _ in throw CommerceFailure(409, "Expired") }, pending: { nil }); XCTFail() } catch {}
    XCTAssertEqual(flow.phase, .editing); XCTAssertNil(flow.quote)
  }
  func testResetDiscardsLateQuoteAndOrderResponses() async throws {
    let flow = CheckoutFlow(); let quote = try fixture("quote", CommerceQuote.self)
    do { try await flow.review { flow.reset(); return quote }; XCTFail() } catch is CancellationError {}
    XCTAssertNil(flow.quote)
    flow.restore(quote)
    var pendingRead = false
    do { _ = try await flow.place({ _ in flow.reset(); return try self.fixture("detail", CustomerOrderDetail.self) }, pending: { pendingRead = true; return quote }); XCTFail() } catch is CancellationError {}
    XCTAssertFalse(pendingRead); XCTAssertEqual(flow.phase, .editing)
  }
}
