import XCTest
@testable import RocentoCore

final class LocationRequestTests: XCTestCase {
  func testCancellationAndReplacementRejectLateLocationAndAuthorization() {
    var request = LocationRequest()
    let first = request.begin()
    XCTAssertTrue(request.accepts(first))
    request.cancel()
    XCTAssertFalse(request.accepts(first))
    let next = request.begin()
    XCTAssertFalse(request.accepts(first))
    XCTAssertTrue(request.accepts(next))
    let replacement = request.begin()
    XCTAssertFalse(request.accepts(next))
    XCTAssertTrue(request.accepts(replacement))
  }
}
