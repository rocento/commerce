import RocentoCore
import SwiftUI

@main struct StorefrontApp: App {
  @UIApplicationDelegateAdaptor(OrderPushDelegate.self) private var pushDelegate
  var body: some Scene { WindowGroup {
    #if DEBUG
    if let phase = ProcessInfo.processInfo.environment["ROCENTO_KEYCHAIN_UPGRADE_PHASE"] {
      KeychainUpgradeView(phase: phase)
    } else { StorefrontRoot() }
    #else
    StorefrontRoot()
    #endif
  } }
}
private struct StorefrontRoot: View {
  @StateObject private var model = StorefrontModel()
  var body: some View { StorefrontView(model: model) }
}
@MainActor final class StorefrontModel: ObservableObject {
  private var presentationGeneration = 0
  @Published var config: MobileConfig?
  let catalogStore: CatalogStore
  var products: [Product] { catalogStore.products }
  var collections: [String: [Product]] { catalogStore.collections }
  var categories: [RocentoCore.Category] { catalogStore.categories }
  var selectedCategory: String? { catalogStore.selectedCategory }
  var categoryProducts: [Product] { catalogStore.categoryProducts }
  var categoryFilters: CatalogFilters { get { catalogStore.categoryFilters } set { catalogStore.categoryFilters = newValue } }
  var categoryAttributes: [CatalogAttribute] { catalogStore.categoryAttributes }
  var categoryFacets: [String: [String: Int]] { catalogStore.categoryFacets }
  var categoryTotal: Int { catalogStore.categoryTotal }
  var categoryHasMore: Bool { catalogStore.categoryHasMore }
  var categoryLoading: Bool { catalogStore.categoryLoading }
  var categoryError: String? { catalogStore.categoryError }
  var selectedProduct: Product? { get { catalogStore.selectedProduct } set { if newValue == nil { catalogStore.dismissProduct() } } }
  var variants: [Product] { catalogStore.variants }
  var assistantPresented: Bool { get { shopping.session.navigation.assistantPresented } set { shopping.session.navigation.presentAssistant(newValue) } }
  var selectedTab: String { get { shopping.session.navigation.tab } set { shopping.session.navigation.selectTab(newValue) } }
  var locale: String { shopping.settings.locale }
  @Published var problem: String?
  @Published var loading = false
  let storeSlug: String
  let production: Bool
  let runtime: ShoppingRuntime
  let shopping: ShoppingModel
  let merchant: Int
  let identity: AppIdentity
  let catalog: any CatalogServing
  @Published var configSource = "bundled"
  @Published var brandAssets: [String: Data] = [:]
  @Published var decodedBrandAssets: [String: UIImage] = [:]
  private var artworkTask: Task<Void, Never>?
  let integration: StorefrontIntegration
  init() {
    merchant =
      (Bundle.main.object(forInfoDictionaryKey: "RocentoMerchant") as? String).flatMap(Int.init)
      ?? 1
    production = Bundle.main.object(forInfoDictionaryKey: "RocentoProduction") as? String == "YES"
    storeSlug = Bundle.main.object(forInfoDictionaryKey: "RocentoStore") as? String ?? "grocery"
    // Build-time binding; never read an endpoint or merchant from remote config.
    identity = try! AppIdentity(
      merchantID: production
        ? (Bundle.main.object(forInfoDictionaryKey: "RocentoTenant") as! String) : "00000000-0000-0000-0000-00000000000\(merchant)",
      environment: production ? "production" : "preview",
      commerceBaseURL: URL(
        string: production
          ? "https://\(storeSlug).rocento.com/api" : "https://merchant-\(merchant).example.test/api")!)
    let fallback = try! Bundled.data(production ? "rocento-\(storeSlug)" : "merchant-\(merchant)")
    config = try? ConfigValidation.decode(fallback, identity: identity, bundled: true)
    var commerceTransport: any HTTPTransport = URLSessionTransport()
    var credentials: any CredentialStorage = SecureSession(
      identity: identity, purpose: "customer-refresh")
    var attempts: any CredentialStorage = SecureSession(
      identity: identity, purpose: "checkout-attempt")
    var integrationCredentials: (String) -> any CredentialStorage = { [identity] in SecureSession(identity: identity, purpose: $0) }
    var analyticsCredentials: any CredentialStorage = SecureSession(identity: identity, purpose: "analytics-consent")
    #if DEBUG
      if let acceptance = AcceptanceTransport(
        json: ProcessInfo.processInfo.environment["ROCENTO_TEST_COMMERCE"])
      {
        commerceTransport = acceptance
        credentials = AcceptanceCredential()
        attempts = AcceptanceCredential()
        integrationCredentials = { _ in AcceptanceCredential() }
        analyticsCredentials = AcceptanceCredential()
      }
    #endif
    integration = StorefrontIntegration(
      identity: identity, fallback: fallback, production: production,
      credentials: integrationCredentials, transport: commerceTransport)
    let commerce = CommerceClient(
      identity: identity, credentials: credentials, attempts: attempts, transport: commerceTransport, reorders: integrationCredentials("reorder-task"), deletionReceipts: integrationCredentials("account-deletion")
    )
    OrderPush.shared.attach(commerce)
    let analytics = CommerceAnalytics(identity: identity, storage: analyticsCredentials, transport: commerceTransport)
    let settings = AppSettingsStore(
      locale: ProcessInfo.processInfo.arguments.contains("-rocento-ar") ? "ar" : (UserDefaults.standard.string(forKey: "storefront.language") ?? (Locale.current.language.languageCode?.identifier == "ar" ? "ar" : "en")),
      analyticsEnabled: analytics.initiallyEnabled,
      saveLocale: { UserDefaults.standard.set($0, forKey: "storefront.language") })
    catalog = production ? commerce : try! FixtureCatalog(data: Bundled.data("catalog-\(merchant)"), identity: identity)
    runtime = ShoppingRuntime(client: commerce, settings: settings, catalog: catalog,
      notificationPreferences: StorefrontNotificationPreferences())
    shopping = ShoppingModel(runtime: runtime, analytics: analytics)
    catalogStore = runtime.catalog
    shopping.onChange = { [weak self] in self?.objectWillChange.send() }
    catalogStore.onChange = { [weak self] in self?.objectWillChange.send() }
    integration.activate(model: self)
  }
  func copy(_ en: String, _ ar: String) -> String { locale == "ar" ? ar : en }
  func toggleLanguage() async {
    guard !loading else { return }
    closeCategory()
    shopping.settings.selectLocale(locale == "ar" ? "en" : "ar")
    // Production catalog names are localized by the API, not stored bilingually.
    catalogStore.changeLocale(locale)
    await load()
  }
  func applyPresentation(_ snapshot: ConfigSnapshot) {
    presentationGeneration += 1
    config = snapshot.config
    configSource = snapshot.source
    // Bundled artwork is available in both builds; a provider may override it.
    brandAssets = snapshot.assets
    var assetIDs = Set([snapshot.config.brand.logoAssetId])
    for section in snapshot.config.screens.home.sections {
      if case .heroBanner(let hero) = section { assetIDs.insert(hero.props.imageAssetId); assetIDs.formUnion(hero.props.additionalImageAssetIds ?? []) }
    }
    var total = brandAssets.values.reduce(0) { $0 + $1.count }
    for id in assetIDs where brandAssets[id] == nil {
      if let bytes = Bundled.asset(id), total + bytes.count <= 20 * 1024 * 1024 {
        brandAssets[id] = bytes
        total += bytes.count
      }
    }
    artworkTask?.cancel()
    let assets = brandAssets
    artworkTask = Task { [weak self] in
      var decoded: [String: UIImage] = [:]
      for (id, data) in assets {
        guard !Task.isCancelled else { return }
        if let image = try? await MerchantImagePipeline.decode(data, pixels: 1024) { decoded[id] = image }
      }
      guard !Task.isCancelled else { return }
      self?.decodedBrandAssets = decoded
    }
  }
  func load() async {
    let expectedGeneration = presentationGeneration
    loading = true
    problem = nil
    defer { loading = false }
    do {
      let snapshot = try await integration.configuration.refresh(locale: locale)
      guard expectedGeneration == presentationGeneration else { return }
      applyPresentation(snapshot)
      try await refreshPresentationCollections()
      if production { shopping.event(.home) }
    } catch is CancellationError {
      return
    } catch { problem = copy("Unable to load. Pull to retry.", "تعذر التحميل. اسحب للمحاولة.") }
  }
  func refreshPresentationCollections() async throws {
    let ids = Set(config?.screens.home.sections.compactMap { section -> String? in
      switch section {
      case .productCarousel(let v): return v.props.collectionId
      case .productGrid(let v): return v.props.collectionId
      default: return nil
      }
    } ?? [])
    try await catalogStore.load(collectionIDs: ids)
  }
  func open(_ action: Action) async {
    switch action {
    case .openTab(let a): selectedTab = a.tab.rawValue
    case .openCategory(let a): await category(a.categoryId)
    case .openProduct(let a): await product(a.productId)
    }
  }
  func search(_ query: String) async { selectedTab = "categories"; await catalogStore.search(query) }
  func category(_ id: String) async { selectedTab = "categories"; await catalogStore.category(id); if production { shopping.event(.catalog) } }
  func closeCategory() { catalogStore.closeCategory() }
  func browseCategory(more: Bool = false) async { await catalogStore.browseCategory(more: more) }
  func product(_ id: String) async {
    do {
      let family: ((String) async throws -> [Product])? = production && !shopping.selectedLocation.isEmpty
        ? { [client = shopping.client] id in try await client.family(id).children } : nil
      try await catalogStore.product(id, family: family)
      if production { shopping.event(.product) }; problem = nil
    } catch is CancellationError { return }
    catch { problem = copy("This product is unavailable.", "هذا المنتج غير متاح.") }
  }
}

@MainActor final class StorefrontNotificationPreferences: NotificationPreferences {
  var orderUpdates: Bool {
    get { UserDefaults.standard.object(forKey: "storefront.orderUpdates") as? Bool ?? true }
    set { UserDefaults.standard.set(newValue, forKey: "storefront.orderUpdates") }
  }
  func readIDs(owner: String) -> Set<String> { Set(UserDefaults.standard.stringArray(forKey: "storefront.notificationRead.\(owner)") ?? []) }
  func setReadIDs(_ ids: Set<String>, owner: String) { UserDefaults.standard.set(Array(ids), forKey: "storefront.notificationRead.\(owner)") }
}
