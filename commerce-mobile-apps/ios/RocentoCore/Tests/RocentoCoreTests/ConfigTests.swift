import XCTest

@testable import RocentoCore

actor StubTransport: HTTPTransport {
  var result: HTTPResult
  var requests: [URLRequest] = []
  init(_ result: HTTPResult) { self.result = result }
  func set(_ result: HTTPResult) { self.result = result }
  func get(_ request: URLRequest, maxBytes: Int) async throws -> HTTPResult {
    requests.append(request)
    return result
  }
}
final class ConfigTests: XCTestCase {
  func identity(_ merchant: Int = 1, environment: String = "staging") throws -> AppIdentity {
    try AppIdentity(
      merchantID: "00000000-0000-0000-0000-00000000000\(merchant)", environment: environment,
      commerceBaseURL: URL(string: "https://merchant-\(merchant).example.test/api")!)
  }
  func config(_ merchant: Int = 1, version: Int = 1, mutate: ((inout [String: Any]) -> Void)? = nil)
    throws -> Data
  {
    var value =
      try JSONSerialization.jsonObject(with: Bundled.data("merchant-\(merchant)")) as! [String: Any]
    value["configVersion"] = version
    mutate?(&value)
    return try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
  }
  func response(_ data: Data) -> HTTPResult {
    let hash = ConfigValidation.digest(data)
    return HTTPResult(
      status: 200, headers: ["ETag": "\"mobile-\(hash)\"", "X-Config-Checksum": hash], body: data)
  }
  func testBothFixturesAndRTL() throws {
    for i in [1, 2] {
      let cfg = try ConfigValidation.decode(
        Bundled.data("merchant-\(i)"), identity: identity(i), bundled: true)
      XCTAssertEqual(cfg.locale("ar"), "ar")
      XCTAssertEqual(cfg.text("featured_title", locale: "ar"), "منتجات مميزة")
      XCTAssertEqual(cfg.screens.home.sections.count, 2)
    }
  }
  func testDealsRequireRuntime12() throws {
    for iconsOnly in [false, true] {
      func bytes(_ minimum: String) throws -> Data {
        try config { value in
          var navigation = value["navigation"] as! [String: Any]
          if iconsOnly { navigation["icons"] = ["home": "deals"] }
          else { navigation["tabs"] = ["home", "categories", "deals", "account", "cart"] }
          value["navigation"] = navigation
          value["compatibility"] = ["minIosRuntime": minimum, "minAndroidRuntime": minimum]
        }
      }
      let current = try identity()
      let old = try AppIdentity(merchantID: current.merchantID, environment: current.environment,
        commerceBaseURL: current.commerceBaseURL, runtimeVersion: "1.1.0")
      XCTAssertThrowsError(try ConfigValidation.decode(bytes("1.1.0"), identity: current))
      XCTAssertThrowsError(try ConfigValidation.decode(bytes("1.1.0"), identity: old))
      XCTAssertThrowsError(try ConfigValidation.decode(bytes("1.2.0"), identity: old))
      XCTAssertNoThrow(try ConfigValidation.decode(bytes("1.2.0"), identity: current))
    }
  }
  func testConfiguredIconsAndLegacyDefaults() throws {
    let legacy = try ConfigValidation.decode(config(), identity: identity())
    XCTAssertNil(legacy.navigation.icons)
    let bytes = try config { value in
      var navigation = value["navigation"] as! [String: Any]
      navigation["icons"] = ["home": "location", "cart": "wishlist"]
      value["navigation"] = navigation
      value["compatibility"] = ["minIosRuntime": "1.1.0", "minAndroidRuntime": "1.1.0"]
    }
    let updated = try ConfigValidation.decode(bytes, identity: identity())
    XCTAssertEqual(updated.navigation.icons?["home"]?.rawValue, "location")
    XCTAssertEqual(updated.navigation.icons?["cart"]?.rawValue, "wishlist")
    let old = try AppIdentity(merchantID: legacy.tenantId, environment: "staging",
      commerceBaseURL: URL(string: "https://merchant-1.example.test/api")!, runtimeVersion: "1.0.0")
    XCTAssertThrowsError(try ConfigValidation.decode(bytes, identity: old))
  }
  func testClosedSchemaTenantAndCompatibility() throws {
    XCTAssertThrowsError(try ConfigValidation.decode(config(2), identity: identity()))
    XCTAssertThrowsError(try ConfigValidation.decode(config(version: 0), identity: identity()))
    for mutation in [
      { (v: inout [String: Any]) in v["javascript"] = "alert(1)" },
      { v in v["compatibility"] = ["minIosRuntime": "2.0.0", "minAndroidRuntime": "1.0.0"] },
      { v in v["screens"] = ["home": ["sections": [["id": "x", "type": "webView", "props": [:]]]]]
      },
      { v in
        var b = v["brand"] as! [String: Any]
        var p = b["light"] as! [String: Any]
        p["onPrimary"] = p["primary"]
        b["light"] = p
        v["brand"] = b
      },
    ] {
      XCTAssertThrowsError(
        try ConfigValidation.decode(config(mutate: mutation), identity: identity()))
    }
  }
  func testCommerceUsesBoundOriginAndDoesNotSendConfigCredential() async throws {
    let fixture = try JSONDecoder().decode(CatalogFixture.self, from: Bundled.data("catalog-1"))
    let transport = StubTransport(
      HTTPResult(status: 200, body: try JSONEncoder().encode(fixture.products[0])))
    let catalog = CommerceCatalog(identity: try identity(), transport: transport)
    let product = try await catalog.product(id: fixture.products[0].id, locale: "ar")
    XCTAssertEqual(product.id, fixture.products[0].id)
    let request = await transport.requests.last!
    XCTAssertEqual(request.url?.host, "merchant-1.example.test")
    XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
    XCTAssertEqual(request.value(forHTTPHeaderField: "X-Storefront-Locale"), "ar")
    do {
      _ = try await catalog.product(id: "https://evil.test", locale: "en")
      XCTFail("invalid destination")
    } catch {}
  }
}
