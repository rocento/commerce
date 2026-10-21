import MapKit
import RocentoCore
import SwiftUI

@MainActor final class ShoppingModel: ObservableObject {
  var wishlistIDs: [String] { session.wishlist.state.ids }
  var wishlistProducts: [String: Product] { session.wishlist.state.products }
  var wishlistLoaded: Bool { session.wishlist.state.loaded }
  var wishlistResolved: Set<String> { session.wishlist.state.resolved }
  var wishlistLimit: Int { session.wishlist.state.limit }
  var notificationDetails: [CustomerOrderDetail] { session.notifications.state.details }
  var notificationOwner: String? { session.notifications.state.owner }
  func loadWishlist(_ locale: String, more: Bool = false) async {
    await act(kind: .refresh) { guard customer != nil else { return }; try await session.wishlist.load(locale: locale, more: more) }
  }
  func saveProduct(_ product: Product, saved: Bool) async {
    await act { try await session.wishlist.save(product.id, saved: saved, product: product) }
  }
  func refreshNotifications(more: Bool = false) async {
    await act(kind: .refresh) { guard let owner = customer?.id else { return }; try await session.notifications.refresh(owner: owner, more: more) }
  }
  var onChange: (() -> Void)?
  let runtime: ShoppingRuntime
  let client: CommerceClient
  let assistant: AssistantChatModel
  let analytics: CommerceAnalytics
  let session: ShoppingSession
  let settings: AppSettingsStore
  var analyticsEnabled: Bool { settings.analyticsEnabled }
  var error: String? { get { session.feedback.failure?.message } set { session.feedback.setError(newValue) } }
  var notice: String? { get { session.feedback.notice } set { session.feedback.setNotice(newValue) } }
  var checkout: CheckoutFlow { session.checkout }
  var customer: CustomerAccount? { session.account.customer }
  var cart: CommerceCart? { session.cart.value }
  var locations: [CustomerLocation] { session.delivery.state.locations }
  var orders: [CustomerOrder] {
    get { session.orders.orders }
    set { session.orders.setOrders(newValue) }
  }
  var detail: CustomerOrderDetail? {
    get { session.orders.detail }
    set { session.orders.show(newValue) }
  }
  var quote: CommerceQuote? { checkout.quote }
  var options: FulfillmentOptions? { checkout.options }
  var windows: [String: FulfillmentSlot] {
    get { checkout.windows }
    set { checkout.select(newValue) }
  }
  var uncertainCheckout: Bool { checkout.locked }
  var availability: FulfillmentAvailability? { session.delivery.state.availability }
  var addressDraft: AddressDraft {
    get { session.delivery.state.addressDraft }
    set { session.delivery.editAddress(newValue) }
  }
  var selectedLocation: String {
    get { session.delivery.state.selectedLocation }
    set { session.delivery.update { $0.selectedLocation = newValue } }
  }
  var method: String {
    get { session.delivery.state.method }
    set { session.delivery.update { $0.method = newValue } }
  }
  var source: String {
    get { session.delivery.state.source }
    set { session.delivery.update { $0.source = newValue } }
  }
  var date: Date {
    get { session.delivery.state.date }
    set { session.delivery.update { $0.date = newValue } }
  }
  var asap: Bool {
    get { session.delivery.state.asap }
    set { session.delivery.update { $0.asap = newValue } }
  }
  var loading: OperationLoadingState { session.operations.loading }
  var busy: Bool { loading.busy }
  var day: String { session.delivery.state.selection.date }
  var location: String? { session.delivery.state.selection.location }
  var pickup: String? { session.delivery.state.selection.source }
  init(runtime: ShoppingRuntime, analytics: CommerceAnalytics) {
    self.runtime = runtime
    client = runtime.client; self.analytics = analytics
    session = runtime.session; settings = runtime.settings
    assistant = AssistantChatModel(store: session.assistant)
    settings.onChange = { [weak self] in self?.objectWillChange.send(); self?.onChange?() }
    session.onChange = { [weak self] in self?.objectWillChange.send(); self?.onChange?() }
  }
  func consent(_ enabled: Bool) async {
    await act { try await settings.consent(enabled) { try await analytics.consent($0) } }
  }
  func event(_ value: CommerceEvent) { Task { await analytics.record(value) } }
  func act(kind: OperationKind = .mutation, _ operation: () async throws -> Void) async {
    await session.perform(kind: kind, locale: settings.locale, operation: operation)
  }
  func load() async {
    await act(kind: customer == nil ? .initial : .refresh) {
      try await session.workflows.recover()
    }
  }
  func login(_ identifier: String, _ password: String) async {
    await act { try await session.actions.login(identifier, password: password) }
  }
  @discardableResult func auth(_ action: String, _ identifier: String, password: String? = nil, code: String? = nil) async -> Bool {
    var succeeded = false
    await act {
      try await session.actions.auth(action, identifier: identifier, password: password, code: code)
      succeeded = true
      notice = "Request completed. Check your email or phone when a code is needed."
    }
    return succeeded
  }
  func logout() async {
    await act { try await session.actions.logout { await OrderPush.shared.logout() } }
  }
  func add(_ id: String, quantity: Int = 1) async {
    await act { try await session.cart.add(id, quantity: quantity); notice = CommercePresentation.notice(.addedToBag, locale: settings.locale); event(.added) }
  }
  func refreshAssistantCart() async {
    guard customer != nil else { return }
    await act(kind: .refresh) { try await session.actions.assistantSettled() }
  }
  func applyProposal(_ id: String, location: String?) async throws {
    try await session.operations.run {
      try await session.actions.applyProposal(id, location: location)
    }
  }
  func addAssistantProduct(_ id: String, locale: String, openProduct: (String) -> Void) async {
    await act {
      try await session.actions.addAssistantProduct(id, locale: locale, openProduct: openProduct) {
        notice = CommercePresentation.notice(.addedToBag, locale: locale); event(.added)
      }
    }
  }
  func invalidateCartReview() { checkout.invalidate() }
  var canCheckDelivery: Bool {
    !uncertainCheckout && cart?.fully_reserved == true && cart?.items.isEmpty == false
      && (method == "pickup" ? !source.isEmpty : !selectedLocation.isEmpty)
      && availability?.methods.contains(where: { $0.type == method }) == true
  }
  var canReviewCart: Bool {
    guard canCheckDelivery, customer?.verified == true, let options, !options.groups.isEmpty else { return false }
    return asap || options.groups.allSatisfy { group in
      guard let chosen = windows[group.source_id] else { return false }
      return group.slots.contains { $0.id == chosen.id && $0.availability == "AVAILABLE" }
    }
  }
  func quantity(_ id: String, _ value: Int) async { await act { try await session.cart.quantity(id, value) } }
  func applyCoupon(_ code: String) async { await act { try await session.cart.coupon(code) } }
  func saveCartItem(_ item: CommerceCartItem) async {
    await act {
      try await session.workflows.saveForLater(item.id)
    }
  }
  func choose(_ id: String) async {
    await act { try await session.actions.choose(id) }
  }
  func save(pin: CLLocationCoordinate2D, address: String, building: String, floor: String, apartment: String, instructions: String) async {
    await act {
      try await session.actions.save(pin: DeliveryPin(latitude: pin.latitude, longitude: pin.longitude),
        address: address, building: building, floor: floor, apartment: apartment, instructions: instructions)
    }
  }
  func findOptions() async {
    await act { guard canCheckDelivery else { return }; try await checkout.findOptions(client: client, selection: session.delivery.state.selection) }
  }
  func review() async {
    await act { guard canReviewCart else { return }; try await checkout.review(client: client, selection: session.delivery.state.selection); event(.checkout) }
  }
  func place() async {
    await act {
      try await session.actions.place { _ in event(.ordered); notice = CommercePresentation.notice(.orderConfirmed, locale: settings.locale) }
    }
  }
  var ordersHasMore: Bool { session.orders.hasMore }
  func refreshOrders(more: Bool = false) async { await act(kind: .refresh) { _ = try await session.orders.refresh(more: more) } }
  func track(_ id: String) async { await act(kind: .refresh) { try await session.orders.track(id) } }
}

