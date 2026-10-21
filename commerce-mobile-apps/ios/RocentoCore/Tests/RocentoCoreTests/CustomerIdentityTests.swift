import XCTest
@testable import RocentoCore

final class CustomerIdentityTests: XCTestCase {
  func testProductionEmailAndMobileIdentifiers() throws {
    for (kind, expected) in [("email", "customer@example.test"), ("mobile", "+201012345678")] {
      let data = try JSONSerialization.data(withJSONObject: [
        "id": "customer", "primary_identifier": kind, "verified": true,
        "email": "customer@example.test", "mobile_number": "+201012345678",
      ])
      XCTAssertEqual(try JSONDecoder().decode(CustomerAccount.self, from: data).identifier, expected)
    }
  }
  func testMissingContactNeverUsesTheIdentifierKindAsAnAddress() throws {
    let data = Data(#"{"id":"customer","primary_identifier":"email","verified":false}"#.utf8)
    XCTAssertEqual(try JSONDecoder().decode(CustomerAccount.self, from: data).identifier, "")
  }
}
