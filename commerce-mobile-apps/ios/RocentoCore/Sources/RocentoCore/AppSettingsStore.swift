/// App preferences survive customer changes. Platform adapters own persistence.
@MainActor public final class AppSettingsStore {
  public private(set) var locale: String
  public private(set) var analyticsEnabled: Bool
  public var onChange: (() -> Void)?
  private let saveLocale: (String) -> Void
  public init(locale: String = "en", analyticsEnabled: Bool = false, saveLocale: @escaping (String) -> Void = { _ in }) {
    self.locale = locale == "ar" ? "ar" : "en"
    self.analyticsEnabled = analyticsEnabled; self.saveLocale = saveLocale
  }
  public func selectLocale(_ value: String) {
    guard ["en", "ar"].contains(value), value != locale else { return }
    saveLocale(value); locale = value; onChange?()
  }
  /// Call inside the shared operation gate; publish only after consent succeeds.
  public func consent(_ value: Bool, save: (Bool) async throws -> Void) async throws {
    try await save(value); analyticsEnabled = value; onChange?()
  }
}
