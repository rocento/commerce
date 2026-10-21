import RocentoCore
import SwiftUI

/// Standalone composition: this file cannot import the optional builder module.
@MainActor final class StorefrontIntegration: ObservableObject {
  let configuration: any StorefrontConfiguration
  func activate(model: StorefrontModel) {}
  init(identity: AppIdentity, fallback: Data, production: Bool,
       credentials: (String) -> any CredentialStorage, transport: any HTTPTransport) {
    configuration = try! BundledConfiguration(identity: identity, data: fallback)
  }
}

struct StorefrontSettings: View {
  let model: StorefrontModel
  var body: some View { EmptyView() }
}

#if DEBUG
// Standalone must leave optional integration storage untouched.
func verifyUpgradeConfiguration(identity: AppIdentity, phase: String) async throws {}
#endif
