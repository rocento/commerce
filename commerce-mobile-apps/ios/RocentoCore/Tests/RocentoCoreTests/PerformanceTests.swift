import XCTest
@testable import RocentoCore

private actor MediaProbe: HTTPTransport {
  var requests: [URLRequest] = []
  let started: XCTestExpectation?
  let cancelled: XCTestExpectation?
  var release: CheckedContinuation<Void, Never>?
  var wait = false
  var fallback = false
  init(started: XCTestExpectation? = nil, cancelled: XCTestExpectation? = nil, wait: Bool = false, fallback: Bool = false) {
    self.started = started; self.cancelled = cancelled; self.wait = wait; self.fallback = fallback
  }
  func get(_ request: URLRequest, maxBytes: Int) async throws -> HTTPResult {
    requests.append(request); started?.fulfill()
    XCTAssertNil(request.value(forHTTPHeaderField: "Authorization")); XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
    if cancelled != nil {
      do { try await Task.sleep(for: .seconds(60)) } catch { cancelled?.fulfill(); throw error }
    } else if wait { await withCheckedContinuation { release = $0 } }
    if fallback && request.url!.query!.contains("width=") { return HTTPResult(status: 404) }
    return HTTPResult(status: 200, body: Data([1, 2, 3]))
  }
  func resume() { wait = false; release?.resume(); release = nil }
}

private actor CatalogProbe: CatalogServing {
  var active = 0, peak = 0, completed = 0
  private func work() async throws {
    active += 1; peak = max(peak, active)
    defer { active -= 1; completed += 1 }
    try await Task.sleep(for: .milliseconds(20))
  }
  func categories(locale: String) async throws -> [RocentoCore.Category] { try await work(); return [] }
  func products(category: String?, locale: String) async throws -> [Product] { try await work(); return [] }
  func product(id: String, locale: String) async throws -> Product { throw MobileFailure.invalidResponse }
}

@MainActor final class PerformanceTests: XCTestCase {
  func testCatalogRequestsOverlapButStayBounded() async throws {
    let provider = CatalogProbe()
    let catalog = CatalogStore(catalog: provider)
    try await catalog.load(collectionIDs: Set((0..<12).map(String.init)))
    let peak = await provider.peak, count = await provider.completed
    XCTAssertEqual(peak, 4); XCTAssertEqual(count, 14); XCTAssertEqual(catalog.collections.count, 12)
  }
  func testCancelledHomeLoadNeverPublishesOldLocale() async throws {
    let store = CatalogStore(catalog: CatalogProbe())
    let old = Task { try await store.load(collectionIDs: ["old"]) }
    await Task.yield(); store.changeLocale("ar"); old.cancel()
    do { try await old.value; XCTFail("Cancelled load succeeded") } catch is CancellationError {}
    XCTAssertTrue(store.collections.isEmpty)
    try await store.load(collectionIDs: ["new"])
    XCTAssertEqual(Set(store.collections.keys), ["new"])
  }
  func testImageRequestsAreSharedAndOneCancelledReaderDoesNotCancelAnother() async throws {
    let started = expectation(description: "single image request")
    let transport = MediaProbe(started: started, wait: true), url = URL(string: "https://one.example/image?width=480")!
    let loader = ImageDataLoader(transport: transport)
    let first = Task { try await loader.load(url) }
    await fulfillment(of: [started], timeout: 2)
    let second = Task { try await loader.load(url) }
    for _ in 0..<20 { await Task.yield() }
    first.cancel(); await transport.resume()
    let image = try await second.value
    XCTAssertEqual(image, Data([1, 2, 3]))
    do { _ = try await first.value; XCTFail("Cancelled reader returned an image") } catch is CancellationError {}
    let requests = await transport.requests; XCTAssertEqual(requests.count, 1)
  }
  func testLastImageReaderCancelsTransport() async throws {
    let started = expectation(description: "started"), cancelled = expectation(description: "socket cancelled")
    let loader = ImageDataLoader(transport: MediaProbe(started: started, cancelled: cancelled))
    let task = Task { try await loader.load(URL(string: "https://one.example/image")!) }
    await fulfillment(of: [started], timeout: 2); task.cancel()
    do { _ = try await task.value; XCTFail("Cancelled image succeeded") } catch is CancellationError {}
    await fulfillment(of: [cancelled], timeout: 2)
  }
  func testImageFallbackKeepsOriginAndOtherQueryParameters() async throws {
    let transport = MediaProbe(fallback: true), loader = ImageDataLoader(transport: transport)
    _ = try await loader.load(URL(string: "https://one.example/image?width=480&revision=3")!)
    _ = try await loader.load(URL(string: "https://two.example/image?width=480&revision=3")!)
    let requests = await transport.requests
    XCTAssertEqual(requests.count, 4)
    XCTAssertEqual(requests[1].url?.absoluteString, "https://one.example/image?revision=3")
    XCTAssertEqual(requests[3].url?.host, "two.example")
  }
}
