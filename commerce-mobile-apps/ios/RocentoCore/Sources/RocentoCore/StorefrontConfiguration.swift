import Foundation

public struct ConfigSnapshot: Sendable {
  public let config: MobileConfig
  public let source: String
  public let assets: [String: Data]
  public init(config: MobileConfig, source: String, assets: [String: Data] = [:]) {
    self.config = config
    self.source = source
    self.assets = assets
  }
}

/// Presentation input for the native UI. Commerce never depends on its source.
public protocol StorefrontConfiguration: Sendable {
  func refresh(locale: String) async throws -> ConfigSnapshot
}

/// Self-contained configuration with no transport, enrollment, or remote cache.
public struct BundledConfiguration: StorefrontConfiguration {
  public let snapshot: ConfigSnapshot
  public init(identity: AppIdentity, data: Data, assets: [String: Data] = [:]) throws {
    snapshot = ConfigSnapshot(
      config: try ConfigValidation.decode(data, identity: identity, bundled: true),
      source: "bundled", assets: assets)
  }
  public func refresh(locale: String) async throws -> ConfigSnapshot { snapshot }
}
