import Foundation

/// Composition and cross-feature resets; feature state is owned by the individual stores.
@MainActor public final class ShoppingSession {
  public let assistant: AssistantStore
  public let checkout = CheckoutFlow()
  public let feedback = FeedbackStore()
  public let operations = OperationCoordinator()
  public let delivery: DeliveryForm
  public let navigation = NavigationStore()
  public let orders: OrderStore
  public let account: AccountStore
  public let cart: CartStore
  public let reorder: ReorderStore
  public let comparison = ComparisonStore()
  public let reviews: ReviewsStore
  public let support: SupportStore
  public let library: AssistantLibrary
  public let wishlist: WishlistStore
  public let notifications: NotificationsStore
  public var onChange: (() -> Void)?
  public var onIdentityChange: (() -> Void)?
  private let client: CommerceClient
  private var generation = 0
  public init(client: CommerceClient, notificationPreferences: (any NotificationPreferences)? = nil) {
    self.client = client
    reviews = ReviewsStore(client: client)
    support = SupportStore(client: client)
    library = AssistantLibrary(client: client)
    wishlist = WishlistStore(client: client)
    notifications = NotificationsStore(client: client, preferences: notificationPreferences ?? MemoryNotificationPreferences())
    assistant = AssistantStore(client: client)
    delivery = DeliveryForm(checkout: checkout)
    orders = OrderStore(client: client)
    account = AccountStore(client: client)
    cart = CartStore(client: client, checkout: checkout)
    let cartStore = cart
    reorder = ReorderStore(client: client, checkout: checkout, accept: { cartStore.accept($0) })
    let changed: () -> Void = { [weak self] in self?.onChange?() }
    feedback.onChange = changed; checkout.onChange = changed; operations.onChange = changed; delivery.onChange = changed
    reorder.onChange = changed
    comparison.onChange = changed; reviews.onChange = changed; support.onChange = changed; library.onChange = changed
    var previousPanel: String?
    navigation.onChange = { [weak self] in
      guard let self else { return }
      let leavingOrder = ["order", "notification-order"].contains(previousPanel ?? "") && navigation.panel != previousPanel
      previousPanel = navigation.panel
      if leavingOrder, orders.selectedID != nil { orders.show(nil) }
      onChange?()
    }
    orders.onChange = changed; account.onChange = changed; cart.onChange = changed; wishlist.onChange = changed; notifications.onChange = changed
    account.onIdentityChange = { [weak self] in
      guard let self else { return }
      generation += 1
      reorder.reset()
      comparison.reset(); reviews.reset(); support.reset(); library.reset()
      feedback.clear(); orders.reset(); navigation.resetCustomerRoutes(preserveAuthentication: account.customer == nil); operations.invalidatePending(); assistant.reset(); checkout.reset(); delivery.reset(); cart.reset(); wishlist.reset(); notifications.reset()
      onIdentityChange?()
    }
  }
  @discardableResult public func perform(kind: OperationKind = .mutation, locale: String = "en", operation: () async throws -> Void) async -> Bool {
    await feedback.perform(using: operations, kind: kind, locale: locale, onUnauthorized: { self.account.reset() }, operation: operation)
  }
  public lazy var workflows: ShoppingWorkflows = makeWorkflows()
  private func makeWorkflows() -> ShoppingWorkflows {
    ShoppingWorkflows(
    restoreAccount: { [weak self] in
      guard let self else { throw CancellationError() }
      do { try await account.restore(); return true }
      catch let failure as CommerceFailure where failure.status == 401 {
        if account.customer != nil { account.reset() }
        return false
      }
    },
    recoverySteps: [
      { [weak self] in
        guard let self else { throw CancellationError() }
        let expected = generation
        checkout.invalidate()
        let pending = try await client.pendingCheckout()?.quote
        guard expected == generation else { throw CancellationError() }
        checkout.restore(pending)
      },
      { [delivery, client] in try await delivery.refresh(client: client) },
      { [cart] in try await cart.refresh() },
      { [orders] in try await orders.refresh() }
    ], revision: { [weak self] in self?.generation ?? -1 },
    saveItem: { [cart] in try await cart.saveForLater($0) },
    refreshWishlist: { [wishlist] in try await wishlist.refreshIDs() })
  }
  public lazy var actions = ShoppingActions(client: client, account: account, cart: cart, delivery: delivery,
    checkout: checkout, orders: orders, wishlist: wishlist, workflows: workflows,
    revision: { [weak self] in self?.generation ?? -1 })
  public func reload() async throws { try await workflows.reload() }
}
