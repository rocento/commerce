import XCTest

import RocentoCore
@testable import RocentoAppBuilder

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
final class BuilderConfigTests: XCTestCase {
  func identity(_ merchant: Int = 1, environment: String = "staging") throws -> AppBuilderIdentity {
    try AppBuilderIdentity(app: AppIdentity(
      merchantID: "00000000-0000-0000-0000-00000000000\(merchant)", environment: environment,
      commerceBaseURL: URL(string: "https://merchant-\(merchant).example.test/api")!), configBaseURL: URL(string: "https://config.example.test")!)
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
  func testCacheNetwork304OfflineCorruptionAndTenantIsolation() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let data = try config()
    let remote = response(try config())
    let transport = StubTransport(remote)
    let store = ConfigStore(
      identity: try identity(), directory: directory, fallback: try Bundled.data("merchant-1"),
      transport: transport)
    let first = try await store.refresh(token: "session", locale: "ar")
    XCTAssertEqual(first.source, "network")
    let request = await transport.requests.last!
    XCTAssertEqual(request.url?.host, "config.example.test")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer session")
    await transport.set(HTTPResult(status: 304, headers: ["ETag": remote.header("etag")!]))
    let cached = try await store.refresh(token: "session", locale: "en")
    XCTAssertEqual(cached.source, "cache")
    await transport.set(HTTPResult(status: 503))
    let offline = try await store.refresh(token: "session", locale: "en")
    XCTAssertEqual(offline.config.configVersion, 1)
    await transport.set(response(try config(2)))
    let wrong = try await store.refresh(token: "session", locale: "en")
    XCTAssertEqual(wrong.config.tenantId, try identity().merchantID)
    await transport.set(
      HTTPResult(status: 200, headers: remote.headers, body: data + Data(" ".utf8)))
    let corrupt = try await store.refresh(token: "session", locale: "en")
    XCTAssertEqual(corrupt.source, "cache")
    let other = ConfigStore(
      identity: try identity(2), directory: directory, fallback: try Bundled.data("merchant-2"),
      transport: transport)
    let otherLoaded = try await other.load()
    XCTAssertEqual(otherLoaded.source, "bundled")
    await transport.set(HTTPResult(status: 401))
    do {
      _ = try await store.refresh(token: "expired", locale: "en")
      XCTFail("must expose re-enrollment")
    } catch MobileFailure.unauthorized {}
    let file = directory.appendingPathComponent(try identity().cacheKey + ".json")
    try Data("broken".utf8).write(to: file)
    let recovered = try await store.load()
    XCTAssertEqual(recovered.source, "bundled")
  }
  func testNewInstallationAndRestartNeverAcceptSupersededConfig() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let remote = response(try config(version: 4))
    let transport = StubTransport(remote)
    let store = ConfigStore(
      identity: try identity(), directory: directory, fallback: try Bundled.data("merchant-1"),
      transport: transport)
    let bundled = try await store.refresh(token: nil, locale: "en")
    XCTAssertEqual(bundled.source, "bundled")
    _ = try await store.refresh(token: "session", locale: "en")
    let restarted = ConfigStore(
      identity: try identity(), directory: directory, fallback: try Bundled.data("merchant-1"),
      transport: transport)
    let persisted = try await restarted.load()
    XCTAssertEqual(persisted.config.configVersion, 4)
    for bytes in [
      try config(version: 3),
      try config(
        version: 4,
        mutate: { value in
          var brand = value["brand"] as! [String: Any]
          brand["displayName"] = "Changed"
          value["brand"] = brand
        }),
    ] {
      await transport.set(response(bytes))
      let snapshot = try await restarted.refresh(token: "session", locale: "en")
      XCTAssertEqual(snapshot.source, "cache")
      XCTAssertEqual(snapshot.config.brand.displayName, "Demo Market")
      XCTAssertEqual(snapshot.config.configVersion, 4)
      let request = await transport.requests.last!
      XCTAssertEqual(request.value(forHTTPHeaderField: "If-None-Match"), remote.header("etag"))
    }
    let production = ConfigStore(
      identity: try identity(environment: "production"), directory: directory,
      fallback: try Bundled.data("merchant-1"), transport: transport)
    let isolated = try await production.load()
    XCTAssertEqual(isolated.source, "bundled")
  }
}
