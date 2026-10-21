import XCTest

import RocentoCore
@testable import RocentoAppBuilder

actor EnrollmentTransport: HTTPTransport {
  var replies: [HTTPResult]
  var requests: [URLRequest] = []
  init(_ replies: [HTTPResult]) { self.replies = replies }
  func get(_ request: URLRequest, maxBytes: Int) async throws -> HTTPResult {
    requests.append(request)
    guard !replies.isEmpty else { throw URLError(.notConnectedToInternet) }
    return replies.removeFirst()
  }
}
final class EnrollmentTests: XCTestCase {
  let merchant = "00000000-0000-0000-0000-000000000001"
  let access = String(repeating: "a", count: 64)
  let device = String(repeating: "d", count: 64)
  func identity() throws -> AppBuilderIdentity {
    try AppBuilderIdentity(app: AppIdentity(
      merchantID: merchant, environment: "production",
      commerceBaseURL: URL(string: "https://shop.example.test/api")!), configBaseURL: URL(string: "https://config.example.test/api")!)
  }
  func session(merchant: String? = nil, device: String? = nil) throws -> HTTPResult {
    var value: [String: Any] = [
      "deviceId": "00000000-0000-0000-0000-000000000003", "accessToken": access, "expiresIn": 1800,
      "merchantId": merchant ?? self.merchant, "platform": "ios",
      "identifier": "com.rocento.grocery", "environment": "production",
    ]
    if let device { value["deviceToken"] = device }
    return HTTPResult(status: 200, body: try JSONSerialization.data(withJSONObject: value))
  }
  func testEnrolledCredentialRenewalAndAuthenticatedAssetBoundary() async throws {
    let png = Data([137, 80, 78, 71])
    let transport = EnrollmentTransport([
      try session(device: device),
      HTTPResult(
        status: 200,
        headers: ["content-type": "image/png", "x-asset-checksum": ConfigValidation.digest(png)],
        body: png),
    ])
    let storage = MemoryCredential()
    let client = EnrollmentClient(
      identity: try identity(), identifier: "com.rocento.grocery", storage: storage,
      transport: transport)
    let absent = try await client.token()
    XCTAssertNil(absent)
    try await client.enroll(code: String(repeating: "c", count: 64))
    XCTAssertEqual(storage.read(), device)
    let bytes = try await client.asset("10000000-0000-0000-0000-000000000001", locale: "ar")
    XCTAssertEqual(bytes, png)
    let requests = await transport.requests
    XCTAssertEqual(requests.count, 2)
    XCTAssertNil(requests[0].value(forHTTPHeaderField: "Authorization"))
    XCTAssertEqual(requests[0].httpMethod, "POST")
    XCTAssertEqual(requests[0].value(forHTTPHeaderField: "X-Commerce-Request"), "1")
    XCTAssertEqual(requests[1].value(forHTTPHeaderField: "Authorization"), "Bearer \(access)")
    XCTAssertTrue(
      requests.allSatisfy {
        $0.url?.host == "config.example.test" && $0.value(forHTTPHeaderField: "Cookie") == nil
      })
    let restartedTransport = EnrollmentTransport([try session(), HTTPResult(status: 401)])
    let restarted = EnrollmentClient(
      identity: try identity(), identifier: "com.rocento.grocery", storage: storage,
      transport: restartedTransport)
    async let one = restarted.token()
    async let two = restarted.token()
    let tokens = try await [one, two]
    XCTAssertEqual(tokens, [access, access])
    let renewals = await restartedTransport.requests
    XCTAssertEqual(renewals.count, 1)
    XCTAssertEqual(renewals[0].url?.path, "/api/v1/mobile/session")
    let revoked = EnrollmentClient(
      identity: try identity(), identifier: "com.rocento.grocery", storage: storage,
      transport: restartedTransport)
    do {
      _ = try await revoked.token()
      XCTFail("revoked accepted")
    } catch MobileFailure.unauthorized {}
    XCTAssertNil(storage.read())
  }
  func testCancellingRenewalCancelsTransportAndPreservesCredential() async throws {
    let started = expectation(description: "Renewal started")
    let cancelled = expectation(description: "Transport cancelled")
    let transport = SuspendedEnrollmentTransport(started: started, cancelled: cancelled)
    let storage = MemoryCredential(device)
    let client = EnrollmentClient(identity: try identity(), identifier: "com.rocento.grocery",
      storage: storage, transport: transport)
    let task = Task { try await client.token() }
    await fulfillment(of: [started], timeout: 2)
    task.cancel()
    await fulfillment(of: [cancelled], timeout: 2)
    do { _ = try await task.value; XCTFail("Cancelled renewal returned a token") }
    catch is CancellationError {}
    XCTAssertEqual(storage.read(), device)
  }
  func testWrongTenantAndCorruptAssetRejectedWithoutCredentialReplacement() async throws {
    let storage = MemoryCredential(device)
    let transport = EnrollmentTransport([
      try session(merchant: "00000000-0000-0000-0000-000000000002", device: device), try session(),
      HTTPResult(
        status: 200, headers: ["content-type": "image/png", "x-asset-checksum": "incorrect"],
        body: Data([1])),
    ])
    let client = EnrollmentClient(
      identity: try identity(), identifier: "com.rocento.grocery", storage: storage,
      transport: transport)
    do {
      try await client.enroll(code: String(repeating: "c", count: 64))
      XCTFail("foreign response accepted")
    } catch {}
    XCTAssertEqual(storage.read(), device)
    do {
      _ = try await client.asset("10000000-0000-0000-0000-000000000001", locale: "en")
      XCTFail("corrupt asset accepted")
    } catch {}
  }
  func testEnrolledInstallationLoadsSuccessivePublicationsAndOfflineSnapshot() async throws {
    let fixtures = BuilderConfigTests()
    let first = try fixtures.config(version: 1)
    let second = try fixtures.config(version: 2) { value in
      var brand = value["brand"] as! [String: Any]
      brand["displayName"] = "Published Rocento update"
      value["brand"] = brand
    }
    let transport = EnrollmentTransport([
      try session(device: device), fixtures.response(first), fixtures.response(second),
    ])
    let client = EnrollmentClient(
      identity: try identity(), identifier: "com.rocento.grocery", storage: MemoryCredential(),
      transport: transport)
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = ConfigStore(
      identity: try identity(), directory: directory, fallback: try Bundled.data("merchant-1"),
      transport: transport)
    try await client.enroll(code: String(repeating: "c", count: 64))
    let one = try await store.refresh(token: client.token(), locale: "en")
    XCTAssertEqual(one.config.configVersion, 1)
    let two = try await store.refresh(token: client.token(), locale: "ar")
    XCTAssertEqual(two.config.configVersion, 2)
    XCTAssertEqual(two.config.brand.displayName, "Published Rocento update")
    let offline = try await store.refresh(token: client.token(), locale: "ar")
    XCTAssertEqual(offline.config.configVersion, 2)
    XCTAssertEqual(offline.source, "cache")
    let requests = await transport.requests
    XCTAssertEqual(
      requests[2].value(forHTTPHeaderField: "If-None-Match"),
      fixtures.response(first).header("etag"))
  }

}

private struct SuspendedEnrollmentTransport: HTTPTransport {
  let started: XCTestExpectation
  let cancelled: XCTestExpectation
  func get(_ request: URLRequest, maxBytes: Int) async throws -> HTTPResult {
    started.fulfill()
    do { try await Task.sleep(nanoseconds: 5_000_000_000) }
    catch { cancelled.fulfill(); throw error }
    return HTTPResult(status: 401)
  }
}
