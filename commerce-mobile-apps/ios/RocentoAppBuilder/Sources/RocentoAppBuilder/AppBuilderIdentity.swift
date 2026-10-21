import Foundation
import RocentoCore

/// Trusted build-time builder origin; never supplied by downloaded configuration.
public struct AppBuilderIdentity: Sendable {
  public let app: AppIdentity
  public let configBaseURL: URL
  public init(app: AppIdentity, configBaseURL: URL) throws {
    guard AppIdentity.safe(configBaseURL) else { throw MobileFailure.invalidEndpoint }
    self.app = app
    self.configBaseURL = configBaseURL
  }
  public var merchantID: String { app.merchantID }
  public var environment: String { app.environment }
  public var runtimeVersion: String { app.runtimeVersion }
  public var cacheKey: String {
    ConfigValidation.digest(Data("\(merchantID)|\(environment)|ios|\(configBaseURL.absoluteString)".utf8))
  }
}
