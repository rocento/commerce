import Foundation

public struct HTTPResult: Sendable {
  public let status: Int
  public let headers: [String: String]
  public let body: Data
  public init(status: Int, headers: [String: String] = [:], body: Data = Data()) {
    self.status = status
    self.headers = headers
    self.body = body
  }
  public func header(_ name: String) -> String? {
    headers.first { $0.key.lowercased() == name.lowercased() }?.value
  }
}
public protocol HTTPTransport: Sendable {
  func get(_ request: URLRequest, maxBytes: Int) async throws -> HTTPResult
  func stream(_ request: URLRequest, maxBytes: Int,
    onResponse: @Sendable (HTTPResult) async throws -> Void,
    onChunk: @Sendable (Data) async throws -> Bool) async throws
}
extension HTTPTransport {
  // Deterministic transports can use the buffered implementation; the network implementation streams.
  public func stream(_ request: URLRequest, maxBytes: Int,
    onResponse: @Sendable (HTTPResult) async throws -> Void,
    onChunk: @Sendable (Data) async throws -> Bool) async throws {
    let result = try await get(request, maxBytes: maxBytes)
    guard result.body.count <= maxBytes else { throw MobileFailure.invalidResponse }
    try await onResponse(result)
    _ = try await onChunk(result.body)
  }
}
final class NoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) { completionHandler(nil) }
}
public struct URLSessionTransport: HTTPTransport {
  // Reuse connection pools; commerce responses and credentials are never cached.
  private static let commerceSession = makeSession(cache: nil, timeout: 15)
  private static let streamSession = makeSession(cache: nil, timeout: 35)
  private let session: URLSession
  public init() { session = Self.commerceSession }
  private init(session: URLSession) { self.session = session }
  private static func makeSession(cache: URLCache?, timeout: TimeInterval) -> URLSession {
    let configuration = cache == nil ? URLSessionConfiguration.ephemeral : URLSessionConfiguration.default
    configuration.timeoutIntervalForRequest = timeout
    configuration.timeoutIntervalForResource = 40
    configuration.httpCookieStorage = nil
    configuration.urlCredentialStorage = nil
    configuration.urlCache = cache
    configuration.requestCachePolicy = cache == nil ? .reloadIgnoringLocalCacheData : .useProtocolCachePolicy
    configuration.httpMaximumConnectionsPerHost = 4
    return URLSession(configuration: configuration, delegate: NoRedirect(), delegateQueue: nil)
  }
  /// Dedicated public-media cache. Never use this transport for authenticated APIs.
  public static let images = URLSessionTransport(session: makeSession(
    cache: URLCache(memoryCapacity: 8 * 1024 * 1024, diskCapacity: 64 * 1024 * 1024,
      directory: FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?.appendingPathComponent("rocento-public-images")),
    timeout: 15))
  public func stream(_ request: URLRequest, maxBytes: Int,
    onResponse: @Sendable (HTTPResult) async throws -> Void,
    onChunk: @Sendable (Data) async throws -> Bool) async throws {
    let (bytes, response) = try await Self.streamSession.bytes(for: request)
    defer { bytes.task.cancel() }
    guard let response = response as? HTTPURLResponse else { throw MobileFailure.invalidResponse }
    try await onResponse(HTTPResult(status: response.statusCode, headers: response.allHeaderFields.reduce(into: [:]) {
      if let key = $1.key as? String, let value = $1.value as? String { $0[key] = value }
    }))
    var chunk = Data(), count = 0
    for try await byte in bytes {
      try Task.checkCancellation()
      count += 1
      guard count <= maxBytes else { throw MobileFailure.invalidResponse }
      chunk.append(byte)
      if byte == 10 || chunk.count == 4096 {
        if try await onChunk(chunk) { return }
        chunk.removeAll(keepingCapacity: true)
      }
    }
    if !chunk.isEmpty { _ = try await onChunk(chunk) }
  }
  public func get(_ request: URLRequest, maxBytes: Int) async throws -> HTTPResult {
    let (bytes, response) = try await session.bytes(for: request)
    defer { bytes.task.cancel() }
    guard let response = response as? HTTPURLResponse else { throw MobileFailure.invalidResponse }
    var data = Data()
    var chunk = [UInt8](); chunk.reserveCapacity(8192)
    var count = 0
    for try await byte in bytes {
      try Task.checkCancellation()
      count += 1
      guard count <= maxBytes else { throw MobileFailure.invalidResponse }
      chunk.append(byte)
      if chunk.count == 8192 { data.append(contentsOf: chunk); chunk.removeAll(keepingCapacity: true) }
    }
    data.append(contentsOf: chunk)
    return HTTPResult(
      status: response.statusCode,
      headers: response.allHeaderFields.reduce(into: [:]) {
        if let key = $1.key as? String, let value = $1.value as? String { $0[key] = value }
      }, body: data)
  }
}
