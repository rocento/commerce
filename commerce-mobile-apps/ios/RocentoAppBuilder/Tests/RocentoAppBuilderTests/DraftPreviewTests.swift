import XCTest
import RocentoCore
@testable import RocentoAppBuilder

final class DraftPreviewTests: XCTestCase {
  let session = UUID()
  func reply(_ bytes: Data, revision: Int = 1) -> HTTPResult {
    HTTPResult(status: 200, headers: ["x-preview-session": session.uuidString.lowercased(), "x-preview-revision": String(revision), "x-config-checksum": ConfigValidation.digest(bytes)], body: bytes)
  }
  func channel(_ transport: StubTransport) throws -> HTTPDraftPreviewTransport {
    try HTTPDraftPreviewTransport(identity: BuilderConfigTests().identity(), code: "\(session.uuidString).\(String(repeating: "a", count: 64))", transport: transport)
  }
  func testSnapshotValidationAndTenantIsolation() async throws {
    let fixtures = BuilderConfigTests()
    let transport = StubTransport(reply(try fixtures.config(version: 0)))
    let client = try channel(transport)
    let update = try await client.snapshot()
    XCTAssertEqual(update.revision, 1)
    XCTAssertEqual(update.snapshot.config.configVersion, 0)
    let requests = await transport.requests
    XCTAssertTrue(requests[0].url!.absoluteString.contains("environment=staging"))
    XCTAssertEqual(requests[0].value(forHTTPHeaderField: "Authorization"), "Bearer \(String(repeating: "a", count: 64))")
    await transport.set(reply(try fixtures.config(2, version: 0), revision: 2))
    do { _ = try await client.snapshot(); XCTFail("wrong tenant accepted") } catch MobileFailure.wrongMerchant {}
    await transport.set(reply(try fixtures.config(version: 1), revision: 2))
    do { _ = try await client.snapshot(); XCTFail("published snapshot accepted as draft") } catch MobileFailure.invalidConfig {}
    await transport.set(HTTPResult(status: 401))
    do { _ = try await client.snapshot(); XCTFail("expired session accepted") } catch MobileFailure.unauthorized {}
  }
  func testCorruptIncompatibleAndRegressedSnapshotsRejected() async throws {
    let f = BuilderConfigTests()
    let bytes = try f.config(version: 0)
    let transport = StubTransport(reply(bytes, revision: 2))
    let client = try channel(transport)
    _ = try await client.snapshot()
    await transport.set(reply(bytes, revision: 1))
    do { _ = try await client.snapshot(); XCTFail("regression") } catch MobileFailure.invalidResponse {}
    let modified = try f.config(version: 0) { $0["brand"] = [:] }
    await transport.set(reply(modified, revision: 3))
    do { _ = try await client.snapshot(); XCTFail("invalid definition") } catch {}
    await transport.set(HTTPResult(status: 200, headers: reply(bytes, revision: 3).headers, body: bytes + Data(" ".utf8)))
    do { _ = try await client.snapshot(); XCTFail("checksum") } catch MobileFailure.invalidResponse {}
  }
  @MainActor func testStableRevisionIdempotenceAndLastGoodState() throws {
    let runtime = DraftPreviewRuntime()
    let f = BuilderConfigTests()
    let config = try ConfigValidation.decode(f.config(version: 0), identity: f.identity().app, bundled: true)
    let snapshot = ConfigSnapshot(config: config, source: "draft")
    var count = 0
    let update = DraftPreviewUpdate(revision: 4, checksum: "a", snapshot: snapshot)
    try runtime.receive(update) { _ in count += 1 }
    try runtime.receive(update) { _ in count += 1 }
    XCTAssertEqual(count, 1)
    XCTAssertThrowsError(try runtime.receive(.init(revision: 3, checksum: "b", snapshot: snapshot)) { _ in count += 1 })
    XCTAssertThrowsError(try runtime.receive(.init(revision: 4, checksum: "b", snapshot: snapshot)) { _ in count += 1 })
    XCTAssertEqual(runtime.appliedRevision, 4)
    XCTAssertEqual(count, 1)
    try runtime.receive(.init(revision: 9, checksum: "c", snapshot: snapshot)) { _ in count += 1 }
    XCTAssertEqual(runtime.appliedRevision, 9) // Full snapshots recover missed revisions.
  }
  @MainActor func testDraftProviderNeverOverwritesPublishedFallback() async throws {
    let f = BuilderConfigTests()
    let fallback = try BundledConfiguration(identity: f.identity().app, data: f.config(version: 2))
    let provider = DraftPreviewConfiguration(published: fallback)
    let draft = try ConfigValidation.decode(f.config(version: 0), identity: f.identity().app, bundled: true)
    provider.set(ConfigSnapshot(config: draft, source: "draft r8"))
    let active = try await provider.refresh(locale: "en")
    XCTAssertEqual(active.source, "draft r8")
    provider.set(nil)
    let stopped = try await provider.refresh(locale: "en")
    XCTAssertEqual(stopped.config.configVersion, 2)
  }
}
