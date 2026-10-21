import XCTest
@testable import RocentoCore

final class EditorialTests: XCTestCase {
  func testFourMerchantSnapshotsAndRuntimeGuards() throws {
    for (slug, count) in [("grocery",7),("electronics",8),("jewelry",9),("pharmacy",6)] {
      let data = try Bundled.data("rocento-\(slug)")
      let raw = try JSONSerialization.jsonObject(with: data) as! [String: Any]
      let id = try AppIdentity(merchantID: raw["tenantId"] as! String, environment: "production", commerceBaseURL: URL(string:"https://\(slug).rocento.com/api")!)
      let config = try ConfigValidation.decode(data, identity:id, bundled:true)
      XCTAssertEqual(config.screens.home.sections.count,count)
      XCTAssertEqual(config.screens.home.layout?.rawValue,"storefront")
      XCTAssertNotNil(Bundled.asset(config.brand.logoAssetId))
      for section in config.screens.home.sections {
        if case .heroBanner(let hero) = section { XCTAssertNotNil(Bundled.asset(hero.props.imageAssetId)); for id in hero.props.additionalImageAssetIds ?? [] { XCTAssertNotNil(Bundled.asset(id)) } }
      }
      let old = try AppIdentity(merchantID:id.merchantID,environment:id.environment,commerceBaseURL:id.commerceBaseURL,runtimeVersion:"1.1.0")
      XCTAssertThrowsError(try ConfigValidation.decode(data,identity:old,bundled:true))
      var missing = raw; var localization = missing["localization"] as! [String:Any]; var messages = localization["messages"] as! [String:[String:String]]
      let key = config.screens.home.sections[0].messageKeys.last!
      messages["ar"]?.removeValue(forKey:key); localization["messages"] = messages; missing["localization"] = localization
      XCTAssertThrowsError(try ConfigValidation.decode(JSONSerialization.data(withJSONObject:missing),identity:id,bundled:true))
    }
  }
  func testFeedResolutionAndLimitsFailClosed() throws {
    let data = Data(#"{"configuration":{"pages":{"home":[{"id":"audio","enabled":true,"component":"product_collection","settings":{"query":"wireless & small","category":"audio-category","limit":6}},{"id":"best","enabled":true,"component":"best_sellers","settings":{"period":"today","limit":99}},{"id":"hidden","enabled":false,"component":"product_collection","settings":{}},{"id":"hero","enabled":true,"component":"editorial_hero","settings":{}}]}}}"#.utf8)
    let theme = try JSONDecoder().decode(DemoTheme.self,from:data)
    let feed = try theme.feed("audio")
    XCTAssertEqual(feed.limit,6)
    XCTAssertEqual(feed.query.first { $0.name == "category_id" }?.value,"audio-category")
    XCTAssertEqual(feed.query.first { $0.name == "q" }?.value,"wireless & small")
    XCTAssertEqual(try theme.feed("best").limit,24)
    for id in ["hidden","missing","hero","https://evil.test"] { XCTAssertThrowsError(try theme.feed(id)) }
  }
}
