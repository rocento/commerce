import XCTest
@testable import RocentoCore

final class StandaloneTests: XCTestCase {
  func testBundledDesignAndLocalAssetsSurviveRefreshAndRestartWithoutServices() async throws {
    let identity = try AppIdentity(merchantID: "00000000-0000-0000-0000-000000000001",
      environment: "production", commerceBaseURL: URL(string: "https://shop.example.test/api")!)
    let data = try Bundled.data("merchant-1")
    let assets = ["local-logo": Data([1, 2, 3])]
    for _ in 0..<2 {
      let provider = try BundledConfiguration(identity: identity, data: data, assets: assets)
      for locale in ["en", "ar"] {
        let result = try await provider.refresh(locale: locale)
        XCTAssertEqual(result.source, "bundled")
        XCTAssertEqual(result.config.configVersion, 0)
        XCTAssertEqual(result.assets, assets)
        XCTAssertEqual(result.config.locale(locale), locale)
      }
    }
    // Commerce session scope is fixed by merchant/environment/commerce origin only.
    let other = try AppIdentity(merchantID: identity.merchantID, environment: "production",
      commerceBaseURL: URL(string: "https://another.example.test/api")!)
    XCTAssertNotEqual(identity.cacheKey, other.cacheKey)
  }
  func testStandaloneStillRejectsWrongMerchantAndUnsafeCommerceOrigin() throws {
    let identity = try AppIdentity(merchantID: "00000000-0000-0000-0000-000000000002",
      environment: "production", commerceBaseURL: URL(string: "https://shop.example.test/api")!)
    XCTAssertThrowsError(try BundledConfiguration(identity: identity, data: Bundled.data("merchant-1")))
    XCTAssertThrowsError(try AppIdentity(merchantID: identity.merchantID, environment: "production",
      commerceBaseURL: URL(string: "http://shop.example.test/api")!))
  }
}
