import Foundation
import RocentoCore

/// Optional published-design adapter. A failed builder must never prevent shopping.
public struct AppBuilderConfiguration: StorefrontConfiguration {
  public let enrollment: EnrollmentClient
  private let store: ConfigStore
  public init(identity: AppBuilderIdentity, identifier: String, storage: any CredentialStorage,
              directory: URL, fallback: Data, transport: any HTTPTransport = URLSessionTransport()) {
    enrollment = EnrollmentClient(identity: identity, identifier: identifier, storage: storage, transport: transport)
    store = ConfigStore(identity: identity, directory: directory, fallback: fallback, transport: transport)
  }
  public func refresh(locale: String) async throws -> ConfigSnapshot {
    try Task.checkCancellation()
    let snapshot: ConfigSnapshot
    do {
      guard let token = try await enrollment.token() else { return try await store.load() }
      snapshot = try await store.fetch(token: token, locale: locale)
    } catch {
      try rethrowBuilderCancellation(error)
      // Do not retry a failed session/config request for each optional image.
      return try await store.load()
    }
    var assets: [String: Data] = [:]
    if await enrollment.connected() {
      var ids = Set([snapshot.config.brand.logoAssetId])
      for section in snapshot.config.screens.home.sections {
        if case .heroBanner(let hero) = section { ids.insert(hero.props.imageAssetId); ids.formUnion(hero.props.additionalImageAssetIds ?? []) }
      }
      var total = 0
      for id in ids {
        do {
          let bytes = try await enrollment.asset(id, locale: locale)
          if total + bytes.count <= 20 * 1024 * 1024 {
            assets[id] = bytes
            total += bytes.count
          }
        } catch {
          try rethrowBuilderCancellation(error)
          // One artwork failure is enough to use the native fallback this refresh.
          break
        }
      }
    }
    try Task.checkCancellation()
    return ConfigSnapshot(config: snapshot.config, source: snapshot.source, assets: assets)
  }
}

// URLSession reports cancellation as URLError.cancelled, not always CancellationError.
func rethrowBuilderCancellation(_ error: Error) throws {
  try Task.checkCancellation()
  if error is CancellationError || (error as? URLError)?.code == .cancelled {
    throw CancellationError()
  }
}
