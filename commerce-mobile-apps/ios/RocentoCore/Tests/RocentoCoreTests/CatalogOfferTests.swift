import XCTest
@testable import RocentoCore

final class CatalogOfferTests: XCTestCase {
  func testOnlyMatchingLowerNonnegativeOffersChangeDisplayPrice() throws {
    for (offerID, currency, original, discounted, expected) in [
      ("p", "USD", "10.00", "8.00", "8.00"),
      ("other", "USD", "10", "8", "10"),
      ("p", "EGP", "10", "8", "10"),
      ("p", "USD", "12", "8", "10"),
      ("p", "USD", "10", "-1", "10"),
      ("p", "USD", "10", "11", "10"),
      ("p", "USD", "10", "0", "0")
    ] {
      let value: [String: Any] = ["id":"p", "name":"Product", "description":"", "price":"10", "currency":"USD", "in_stock":true,
        "catalog_offer":["product_id":offerID, "currency":currency, "original_price":original, "discounted_price":discounted]]
      let product = try JSONDecoder().decode(Product.self, from: JSONSerialization.data(withJSONObject: value))
      XCTAssertEqual(product.displayPrice, expected)
    }
  }
}
