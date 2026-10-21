#if DEBUG
import Foundation
import RocentoCore

/// In-memory bearer capability, scoped server-side to one tenant/environment/session.
public actor HTTPDraftPreviewTransport: DraftPreviewTransport {
  private let identity: AppBuilderIdentity
  private let session: UUID
  private let token: String
  private let transport: any HTTPTransport
  private var cached: DraftPreviewUpdate?

  public init(identity: AppBuilderIdentity, code: String, transport: any HTTPTransport = URLSessionTransport()) throws {
    let parts = code.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 2, let session = UUID(uuidString: String(parts[0])),
      parts[1].utf8.count == 64, parts[1].allSatisfy({ "0123456789abcdefABCDEF".contains($0) })
    else { throw MobileFailure.invalidResponse }
    self.identity = identity; self.session = session; self.token = String(parts[1]); self.transport = transport
  }
  private func request(_ suffix: String = "") -> URLRequest {
    var url = URLComponents(url: identity.configBaseURL.appendingPathComponent("v1/mobile/preview/\(session.uuidString.lowercased())\(suffix)"), resolvingAgainstBaseURL: false)!
    url.queryItems = [
      .init(name: "merchantId", value: identity.merchantID),
      .init(name: "environment", value: identity.environment),
      .init(name: "runtimeVersion", value: identity.runtimeVersion)
    ]
    var request = URLRequest(url: url.url!)
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.timeoutInterval = 15
    return request
  }
  public func snapshot() async throws -> DraftPreviewUpdate {
    let result = try await transport.get(request(), maxBytes: 131_072)
    try Task.checkCancellation()
    if [401,403].contains(result.status) { throw MobileFailure.unauthorized }
    guard result.status == 200,
      result.header("x-preview-session").flatMap(UUID.init(uuidString:)) == session,
      let revision = result.header("x-preview-revision").flatMap(Int.init), revision > 0,
      let checksum = result.header("x-config-checksum"), checksum == ConfigValidation.digest(result.body)
    else { throw MobileFailure.invalidResponse }
    if let cached, cached.revision == revision {
      guard cached.checksum == checksum else { throw MobileFailure.invalidResponse }
      return cached
    }
    if let cached, revision < cached.revision { throw MobileFailure.invalidResponse }
    // Full schema, tenant, runtime, token, contrast and reference validation still applies.
    // The local-data mode permits draft configVersion 0 without weakening production loads.
    let config = try ConfigValidation.decode(result.body, identity: identity.app, bundled: true)
    guard config.configVersion == 0 else { throw MobileFailure.invalidConfig }
    var assets: [String: Data] = [:]
    var ids = Set([config.brand.logoAssetId])
    for section in config.screens.home.sections {
      if case .heroBanner(let hero) = section { ids.insert(hero.props.imageAssetId); ids.formUnion(hero.props.additionalImageAssetIds ?? []) }
    }
    var total = 0
    for id in ids.sorted() {
      do {
        let image = try await transport.get(request("/assets/\(id)"), maxBytes: 5 * 1024 * 1024)
        try Task.checkCancellation()
        if [401,403].contains(image.status) { throw MobileFailure.unauthorized }
        guard image.status == 200, image.header("content-type") == "image/png",
          image.header("x-asset-checksum") == ConfigValidation.digest(image.body), total + image.body.count <= 20 * 1024 * 1024
        else { break }
        assets[id] = image.body; total += image.body.count
      } catch {
        try rethrowBuilderCancellation(error)
        if case MobileFailure.unauthorized = error { throw error }
        break
      }
    }
    try Task.checkCancellation()
    let update = DraftPreviewUpdate(revision: revision, checksum: checksum, snapshot: ConfigSnapshot(config: config, source: "draft r\(revision)", assets: assets))
    cached = update
    return update
  }
  public func acknowledge(_ update: DraftPreviewUpdate) async throws {
    var request = request("/ack")
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: ["revision": update.revision, "checksum": update.checksum])
    let result = try await transport.get(request, maxBytes: 1024)
    try Task.checkCancellation()
    if [401,403].contains(result.status) { throw MobileFailure.unauthorized }
    guard result.status == 200 else { throw MobileFailure.invalidResponse }
  }
}

#endif
