import Foundation

public protocol AccountServing: Sendable {
  func restore() async throws -> CustomerAccount
  func me() async throws -> CustomerAccount
  func login(identifier: String, password: String) async throws -> CustomerAccount
  func logout() async throws
  func authAction(_ action: String, identifier: String, password: String?, code: String?) async throws
}
public protocol CartServing: Sendable {
  func cart() async throws -> CommerceCart
  func add(_ id: String, quantity: Int) async throws -> CommerceCart
  func quantity(_ id: String, quantity: Int) async throws -> CommerceCart
  func coupon(_ code: String) async throws -> CommerceCart
  func saveProduct(_ id: String, saved: Bool) async throws
}
public protocol CheckoutServing: Sendable {
  func deliveryOptions(method: String, location: String?, source: String?, date: String, asap: Bool) async throws -> FulfillmentOptions
  func reserveDelivery(method: String, location: String?, source: String?, date: String, asap: Bool, windows: [FulfillmentSlot], key: String) async throws
  func quote(location: String?, giftMessage: String) async throws -> CommerceQuote
  func pendingCheckout() async throws -> CheckoutAttempt?
  func place(_ quote: CommerceQuote) async throws -> CustomerOrderDetail
}
public protocol OrderServing: Sendable {
  func orders(offset: Int) async throws -> [CustomerOrder]
  func order(_ id: String) async throws -> CustomerOrderDetail
}

extension CommerceClient: AccountServing, CartServing, CheckoutServing, OrderServing {}
