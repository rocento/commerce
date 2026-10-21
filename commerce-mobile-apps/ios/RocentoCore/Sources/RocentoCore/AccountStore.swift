import Foundation

@MainActor public final class AccountStore {
  public private(set) var customer: CustomerAccount?
  public var onChange: (() -> Void)?
  public var onIdentityChange: (() -> Void)?
  private var generation = 0
  private let client: any AccountServing
  public init(client: any AccountServing) { self.client = client }
  public func reset() {
    generation += 1; customer = nil
    onIdentityChange?(); onChange?()
  }
  public func accept(_ value: CustomerAccount) {
    if customer?.id != value.id { generation += 1; onIdentityChange?() }
    customer = value; onChange?()
  }
  public func restore() async throws {
    let revision = generation
    let value = try await (customer == nil ? client.restore() : client.me())
    guard revision == generation else { throw CancellationError() }
    accept(value)
  }
  public func login(_ identifier: String, password: String) async throws {
    reset(); let revision = generation
    let value = try await client.login(identifier: identifier, password: password)
    guard revision == generation else { throw CancellationError() }
    accept(value)
  }
  public func logout() async throws { reset(); try await client.logout() }
  public func auth(_ action: String, identifier: String, password: String?, code: String?) async throws {
    let revision = generation
    try await client.authAction(action, identifier: identifier, password: password, code: code)
    guard revision == generation else { throw CancellationError() }
    if action == "reset-password" { reset() }
    else if customer != nil { try await restore() }
  }
}
