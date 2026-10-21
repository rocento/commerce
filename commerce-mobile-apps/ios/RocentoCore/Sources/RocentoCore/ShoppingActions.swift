import Foundation

/// Cross-feature mutations. Call inside ShoppingSession's gate, never recursively.
@MainActor public final class ShoppingActions {
  private let client: CommerceClient
  private let account: AccountStore
  private let cart: CartStore
  private let delivery: DeliveryForm
  private let checkout: CheckoutFlow
  private let orders: OrderStore
  private let wishlist: WishlistStore
  private let workflows: ShoppingWorkflows
  private let revision: () -> Int
  public init(client: CommerceClient, account: AccountStore, cart: CartStore, delivery: DeliveryForm,
              checkout: CheckoutFlow, orders: OrderStore, wishlist: WishlistStore,
              workflows: ShoppingWorkflows, revision: @escaping () -> Int) {
    self.client = client; self.account = account; self.cart = cart; self.delivery = delivery
    self.checkout = checkout; self.orders = orders; self.wishlist = wishlist
    self.workflows = workflows; self.revision = revision
  }
  private func check(_ expected: Int) throws {
    try Task.checkCancellation()
    guard expected == revision() else { throw CancellationError() }
  }
  public func place(confirmed: (CustomerOrderDetail) -> Void) async throws {
    let expected = revision()
    let order = try await checkout.place(client: client)
    try check(expected)
    orders.show(order)
    confirmed(order) // Publish confirmation before any optional read can fail.
    try check(expected)
    try await cart.refresh()
    try check(expected)
    try await orders.refresh()
  }
  public func choose(_ id: String) async throws {
    let expected = revision()
    try await delivery.choose(id, client: client)
    try check(expected)
    try await cart.refresh()
    try check(expected)
  }
  public func save(pin: DeliveryPin, address: String, building: String, floor: String, apartment: String, instructions: String) async throws {
    let expected = revision(); let guest = account.customer == nil
    try await delivery.save(client: client, pin: pin, address: address, building: building,
      floor: floor, apartment: apartment, instructions: instructions, guest: guest)
    try check(expected)
    if !guest { try await cart.refresh(); try check(expected) }
  }
  public func applyProposal(_ id: String, location: String? = nil) async throws {
    let expected = revision()
    try await cart.mutate { try await self.client.applyAssistantProposal(id) }
    try check(expected)
    if let location { try await choose(location) }
    wishlist.invalidate()
  }
  public func assistantSettled() async throws {
    guard account.customer != nil else { return }
    let expected = revision()
    checkout.invalidate(); wishlist.invalidate()
    try await cart.refresh()
    try check(expected)
  }
  public func addAssistantProduct(_ id: String, locale: String, openProduct: (String) -> Void, added: () -> Void) async throws {
    let expected = revision()
    let product = try await client.product(id: id, locale: locale)
    try check(expected)
    if (product.productType ?? "simple") != "simple" { openProduct(id); return }
    guard product.inStock else { throw CommerceFailure(409, "This product is no longer available") }
    try await cart.add(id)
    try check(expected); added()
  }
  public func login(_ identifier: String, password: String, authenticated: () -> Void = {}) async throws {
    try await account.login(identifier, password: password)
    let expected = revision()
    authenticated()
    try check(expected)
    try await workflows.reload()
  }
  public func auth(_ action: String, identifier: String, password: String?, code: String?) async throws {
    try await account.auth(action, identifier: identifier, password: password, code: code)
    if action == "verify", account.customer != nil { try await workflows.reload() }
  }
  public func logout(beforeLogout: () async -> Void = {}) async throws {
    // Push unregister needs the old credentials; the account reset clears queued work.
    await beforeLogout()
    try await account.logout()
  }
}
