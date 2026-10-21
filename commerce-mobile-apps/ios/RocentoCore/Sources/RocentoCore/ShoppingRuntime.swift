import Foundation

/// Composition root for shopping state. Platform persistence is injected by the app.
@MainActor public final class ShoppingRuntime {
  public let client: CommerceClient
  public let settings: AppSettingsStore
  public let session: ShoppingSession
  public let catalog: CatalogStore
  public init(client: CommerceClient, settings: AppSettingsStore,
              catalog: (any CatalogServing)? = nil,
              notificationPreferences: (any NotificationPreferences)? = nil) {
    self.client = client; self.settings = settings
    self.session = ShoppingSession(client: client, notificationPreferences: notificationPreferences)
    self.catalog = CatalogStore(catalog: catalog ?? client, locale: settings.locale)
    let catalogStore = self.catalog
    // Session owns all customer stores, including assistant. Only catalog selection is external.
    session.onIdentityChange = { [weak catalogStore] in catalogStore?.dismissProduct() }
  }
}
