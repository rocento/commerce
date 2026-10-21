import Foundation
import RocentoCore

private struct CacheEnvelope: Codable {
  let body: Data
  let checksum: String
  let etag: String
}
public actor ConfigStore {
  public let identity: AppBuilderIdentity
  let directory: URL
  let fallback: Data
  let transport: any HTTPTransport
  public init(
    identity: AppBuilderIdentity, directory: URL, fallback: Data,
    transport: any HTTPTransport = URLSessionTransport()
  ) {
    self.identity = identity
    self.directory = directory
    self.fallback = fallback
    self.transport = transport
  }
  private var file: URL { directory.appendingPathComponent(identity.cacheKey + ".json") }
  private func cached() -> CacheEnvelope? {
    guard let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 200_000,
      let data = try? Data(contentsOf: file),
      let envelope = try? JSONDecoder().decode(CacheEnvelope.self, from: data),
      envelope.checksum == ConfigValidation.digest(envelope.body),
      envelope.etag == "\"mobile-\(envelope.checksum)\"",
      (try? ConfigValidation.decode(envelope.body, identity: identity.app)) != nil
    else { return nil }
    return envelope
  }
  public func load() throws -> ConfigSnapshot {
    if let cached = cached() {
      return ConfigSnapshot(
        config: try ConfigValidation.decode(cached.body, identity: identity.app), source: "cache")
    }
    return ConfigSnapshot(
      config: try ConfigValidation.decode(fallback, identity: identity.app, bundled: true),
      source: "bundled")
  }
  public func refresh(token: String?, locale: String) async throws -> ConfigSnapshot {
    do { return try await fetch(token: token, locale: locale) }
    catch MobileFailure.unauthorized { throw MobileFailure.unauthorized }
    catch {
      try rethrowBuilderCancellation(error)
      return try load()
    }
  }
  // The adapter needs to distinguish a reachable builder (including 304) from fallback.
  func fetch(token: String?, locale: String) async throws -> ConfigSnapshot {
    try Task.checkCancellation()
    guard let token, !token.isEmpty else { return try load() }
    let previous = cached()
    var url = URLComponents(
      url: identity.configBaseURL.appendingPathComponent("v1/mobile/config"),
      resolvingAgainstBaseURL: false)!
    url.queryItems = [
      .init(name: "platform", value: "ios"),
      .init(name: "runtimeVersion", value: identity.runtimeVersion),
      .init(name: "locale", value: locale == "ar" ? "ar" : "en"),
    ]
    var request = URLRequest(url: url.url!)
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    if let previous { request.setValue(previous.etag, forHTTPHeaderField: "If-None-Match") }
    let response = try await transport.get(request, maxBytes: 131_072)
    try Task.checkCancellation()
    if response.status == 401 || response.status == 403 { throw MobileFailure.unauthorized }
    if response.status == 304 {
      guard let previous, response.header("etag") == previous.etag else {
        throw MobileFailure.invalidResponse
      }
      return try load()
    }
    guard response.status == 200 else { throw MobileFailure.invalidResponse }
    let hash = ConfigValidation.digest(response.body)
    guard response.header("x-config-checksum") == hash,
      response.header("etag") == "\"mobile-\(hash)\""
    else { throw MobileFailure.invalidResponse }
    let config = try ConfigValidation.decode(response.body, identity: identity.app)
    if let previous = cached() {
      let old = try ConfigValidation.decode(previous.body, identity: identity.app)
      guard
        config.configVersion > old.configVersion
          || (config.configVersion == old.configVersion && hash == previous.checksum)
      else { throw MobileFailure.invalidResponse }
    }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try JSONEncoder().encode(
      CacheEnvelope(body: response.body, checksum: hash, etag: "\"mobile-\(hash)\"")
    ).write(to: file, options: .atomic)
    return ConfigSnapshot(config: config, source: "network")
  }
}
