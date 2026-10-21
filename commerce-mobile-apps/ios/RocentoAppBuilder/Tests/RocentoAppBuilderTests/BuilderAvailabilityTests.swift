import XCTest
import RocentoCore
@testable import RocentoAppBuilder

final class BuilderAvailabilityTests: XCTestCase {
  func testUnavailableOrRevokedBuilderReturnsBundledDesign() async throws {
    let identity = try BuilderConfigTests().identity()
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    for status in [503, 401] {
      let storage = MemoryCredential(String(repeating: "d", count: 64))
      let transport = StubTransport(HTTPResult(status: status))
      let provider = AppBuilderConfiguration(identity: identity, identifier: "com.rocento.grocery",
        storage: storage, directory: directory, fallback: try Bundled.data("merchant-1"), transport: transport)
      let result = try await provider.refresh(locale: "ar")
      XCTAssertEqual(result.source, "bundled")
      XCTAssertEqual(result.config.tenantId, identity.merchantID)
      XCTAssertTrue(result.assets.isEmpty)
      if status == 401 { XCTAssertNil(storage.read()) }
      let requests = await transport.requests
      XCTAssertEqual(requests.count, 1, "Failed renewal must not be retried for artwork")
    }
  }
  func testConfigurationFailureUsesCacheWithoutFetchingArtwork() async throws {
    let fixture = BuilderConfigTests()
    let identity = try EnrollmentTests().identity()
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let fallback = try Bundled.data("merchant-1")
    let cached = ConfigStore(identity: identity, directory: directory, fallback: fallback,
      transport: StubTransport(fixture.response(try fixture.config(version: 42))))
    _ = try await cached.refresh(token: "test", locale: "en")
    for status in [503, 401] {
      let transport = EnrollmentTransport([try EnrollmentTests().session(), HTTPResult(status: status)])
      let provider = AppBuilderConfiguration(identity: identity, identifier: "com.rocento.grocery",
        storage: MemoryCredential(String(repeating: "d", count: 64)), directory: directory,
        fallback: fallback, transport: transport)
      let result = try await provider.refresh(locale: "en")
      XCTAssertEqual(result.source, "cache")
      XCTAssertEqual(result.config.configVersion, 42)
      XCTAssertTrue(result.assets.isEmpty)
      let requests = await transport.requests
      XCTAssertEqual(requests.count, 2, "Config failure must not fan out into artwork requests")
    }
  }
  func testArtworkFailureStopsFurtherRequests() async throws {
    let fixture = BuilderConfigTests()
    let transport = EnrollmentTransport([try EnrollmentTests().session(),
      fixture.response(try fixture.config()), HTTPResult(status: 503)])
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let provider = AppBuilderConfiguration(identity: try EnrollmentTests().identity(), identifier: "com.rocento.grocery",
      storage: MemoryCredential(String(repeating: "d", count: 64)), directory: directory,
      fallback: try Bundled.data("merchant-1"), transport: transport)
    let result = try await provider.refresh(locale: "en")
    XCTAssertEqual(result.source, "network")
    XCTAssertTrue(result.assets.isEmpty)
    let requests = await transport.requests
    XCTAssertEqual(requests.count, 3)
  }
  func testUnenrolledProviderUsesBundleWithoutRequests() async throws {
    let transport = EnrollmentTransport([])
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let provider = AppBuilderConfiguration(identity: try EnrollmentTests().identity(), identifier: "com.rocento.grocery",
      storage: MemoryCredential(), directory: directory, fallback: try Bundled.data("merchant-1"), transport: transport)
    let result = try await provider.refresh(locale: "en")
    XCTAssertEqual(result.source, "bundled")
    let requests = await transport.requests
    XCTAssertTrue(requests.isEmpty)
  }
  func testCancellationAtEachNetworkStagePreservesCredential() async throws {
    for stage in ["session", "config", "assets"] {
      let transport = AvailabilityTransport(session: try EnrollmentTests().session(),
        config: try BuilderConfigTests().response(BuilderConfigTests().config()), cancelledStage: stage)
      let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
      defer { try? FileManager.default.removeItem(at: directory) }
      let storage = MemoryCredential(String(repeating: "d", count: 64))
      let provider = AppBuilderConfiguration(identity: try EnrollmentTests().identity(), identifier: "com.rocento.grocery",
        storage: storage, directory: directory, fallback: try Bundled.data("merchant-1"), transport: transport)
      do {
        _ = try await provider.refresh(locale: "en")
        XCTFail("Cancellation must not turn into a successful fallback: \(stage)")
      } catch is CancellationError {}
      XCTAssertEqual(storage.read(), String(repeating: "d", count: 64))
    }
  }
  func testNotModifiedPublicationStillLoadsPrivateArtwork() async throws {
    let response = try BuilderConfigTests().response(BuilderConfigTests().config())
    let transport = AvailabilityTransport(session: try EnrollmentTests().session(), config: response)
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let provider = AppBuilderConfiguration(identity: try EnrollmentTests().identity(), identifier: "com.rocento.grocery",
      storage: MemoryCredential(String(repeating: "d", count: 64)), directory: directory,
      fallback: try Bundled.data("merchant-1"), transport: transport)
    let first = try await provider.refresh(locale: "en")
    XCTAssertFalse(first.assets.isEmpty)
    await transport.setConfig(HTTPResult(status: 304, headers: ["etag": response.header("etag")!]))
    let second = try await provider.refresh(locale: "en")
    XCTAssertEqual(second.source, "cache")
    XCTAssertEqual(second.assets, first.assets)
  }
  func testStandaloneIgnoresValidPreviouslyPublishedBuilderCache() async throws {
    let fixture = BuilderConfigTests()
    let identity = try fixture.identity()
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let fallback = try Bundled.data("merchant-1")
    let transport = StubTransport(fixture.response(try fixture.config(version: 42)))
    let remote = ConfigStore(identity: identity, directory: directory, fallback: fallback, transport: transport)
    let published = try await remote.refresh(token: "test", locale: "en")
    XCTAssertEqual(published.config.configVersion, 42)
    let local = try BundledConfiguration(identity: identity.app, data: fallback)
    let result = try await local.refresh(locale: "en")
    XCTAssertEqual(result.config.configVersion, 0)
    XCTAssertEqual(result.source, "bundled")
    XCTAssertTrue(FileManager.default.fileExists(atPath: directory.appendingPathComponent(identity.cacheKey + ".json").path))
  }
}

private actor AvailabilityTransport: HTTPTransport {
  let session: HTTPResult
  var config: HTTPResult
  let cancelledStage: String?
  init(session: HTTPResult, config: HTTPResult, cancelledStage: String? = nil) {
    self.session = session; self.config = config; self.cancelledStage = cancelledStage
  }
  func setConfig(_ response: HTTPResult) { config = response }
  func get(_ request: URLRequest, maxBytes: Int) async throws -> HTTPResult {
    let path = request.url!.path
    if let cancelledStage, path.contains("/\(cancelledStage)") { throw URLError(.cancelled) }
    if path.hasSuffix("/session") { return session }
    if path.hasSuffix("/config") { return config }
    let png = Data([137, 80, 78, 71])
    return HTTPResult(status: 200,
      headers: ["content-type": "image/png", "x-asset-checksum": ConfigValidation.digest(png)], body: png)
  }
}
