import Foundation

@MainActor public final class CartStore {
  public private(set) var value: CommerceCart?
  public var onChange: (() -> Void)?
  private let client: any CartServing
  private let checkout: CheckoutFlow
  private var generation = 0
  public init(client: any CartServing, checkout: CheckoutFlow) { self.client = client; self.checkout = checkout }
  public func reset() { generation += 1; value = nil; onChange?() }
  public func accept(_ cart: CommerceCart) { value = cart; checkout.invalidate(); onChange?() }
  public func refresh() async throws {
    let revision = generation
    let result = try await client.cart()
    guard revision == generation else { throw CancellationError() }
    value = result; onChange?()
  }
  public func mutate(_ operation: () async throws -> CommerceCart) async throws {
    guard !checkout.locked else { throw CommerceFailure(409, "Resolve the previous checkout first") }
    let revision = generation
    checkout.invalidate()
    let result = try await operation()
    guard revision == generation else { throw CancellationError() }
    value = result; onChange?()
  }
  public func add(_ id: String, quantity: Int = 1) async throws {
    guard (1...99).contains(quantity) else { throw CommerceFailure(422, "Invalid quantity") }
    try await mutate { try await client.add(id, quantity: quantity) }
  }
  public func quantity(_ id: String, _ quantity: Int) async throws { try await mutate { try await client.quantity(id, quantity: quantity) } }
  public func coupon(_ code: String) async throws { try await mutate { try await client.coupon(code) } }
  public func saveForLater(_ id: String) async throws {
    let revision = generation
    try await mutate {
      try await client.saveProduct(id, saved: true)
      guard revision == generation else { throw CancellationError() }
      return try await client.quantity(id, quantity: 0)
    }
  }
}
