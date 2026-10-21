import Foundation

public struct ReorderTask: Codable, Sendable {
  public let task: String
  public let pending: Bool
}

@MainActor public final class ReorderStore {
  public private(set) var order: CustomerOrder?
  public private(set) var cart: CommerceCart?
  public private(set) var locations: [CustomerLocation] = []
  public private(set) var proposal: AssistantJSON?
  public private(set) var task: ReorderTask?
  public private(set) var busy = false
  public private(set) var pending = false
  public private(set) var done = false
  public var onChange: (() -> Void)?
  private let client: CommerceClient
  private let checkout: CheckoutFlow
  private let accept: (CommerceCart) -> Void
  private var generation = 0
  public init(client: CommerceClient, checkout: CheckoutFlow, accept: @escaping (CommerceCart) -> Void) {
    self.client = client; self.checkout = checkout; self.accept = accept
  }
  public func reset() { generation += 1; order = nil; cart = nil; locations = []; proposal = nil; task = nil; busy = false; pending = false; done = false; onChange?() }
  public static func signature(_ cart: CommerceCart) -> [[String]] { cart.items.sorted { $0.id < $1.id }.map { [$0.id, String($0.quantity), $0.price] } }
  private func check(_ revision: Int) throws { guard revision == generation, !Task.isCancelled else { throw CancellationError() } }
  private func work(_ operation: (Int) async throws -> Void) async throws {
    guard !busy, !checkout.locked else { throw CommerceFailure(409, "Resolve the previous checkout first") }
    let revision = generation; busy = true; onChange?()
    defer { if revision == generation { busy = false; onChange?() } }
    try await operation(revision)
  }
  public func start(_ order: CustomerOrder, again: Bool = false) async throws {
    if again && (!done || self.order?.id != order.id) { throw CommerceFailure(409, "Check the previous reorder first") }
    try await work { revision in
      self.order = order; proposal = nil; cart = nil; task = nil; locations = []; pending = false; done = false
      let task = try await client.reorderTask(order.id, again: again); try check(revision)
      let cart = try await client.cart(); try check(revision)
      let addresses = try await client.locations(); try check(revision)
      let context = try await client.reorderContext(task.task); try check(revision)
      let proposal: AssistantJSON?
      if let id = context["proposal_id"].string { proposal = try await client.assistantProposal(id); try check(revision) } else { proposal = nil }
      if task.pending && proposal == nil { throw CommerceFailure(409, "The previous basket update cannot be confirmed. Retry loading it.") }
      self.task = task; self.cart = cart; locations = addresses; self.proposal = proposal
      done = proposal?["applied"].bool == true; pending = task.pending && !done; accept(cart)
    }
  }
  public func prepare(location id: String, replace: Bool) async throws {
    try await work { revision in
      guard let order, let task, let expected = cart, !pending, !done, let address = locations.first(where: { $0.id == id }) else { throw CommerceFailure(409, "Reload the reorder before changing it") }
      let addresses = try await client.locations(); try check(revision); locations = addresses
      let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
      guard let current = addresses.first(where: { $0.id == id }), try encoder.encode(current) == encoder.encode(address) else { throw CommerceFailure(409, "That address changed. Confirm the current address.") }
      var latest = try await client.cart(); try check(revision); cart = latest; accept(latest); proposal = nil
      guard Self.signature(latest) == Self.signature(expected) else { throw CommerceFailure(409, "Your cart changed. Review it and choose keep or replace again.") }
      if replace { for item in expected.items {
        let observed = try await client.cart(); try check(revision)
        guard Self.signature(observed) == Self.signature(latest) else { cart = observed; accept(observed); throw CommerceFailure(409, "Your cart changed while clearing it. Review the remaining items.") }
        checkout.invalidate()
        do { latest = try await client.quantity(item.id, quantity: 0); try check(revision) }
        catch { try check(revision); let remaining = try await client.cart(); try check(revision); cart = remaining; accept(remaining); throw error }
        cart = latest; accept(latest)
      } }
      let value = try await client.proposeReorder(task: task.task, order: order.id, location: id); try check(revision); proposal = value
    }
  }
  public func revise(_ selections: [AssistantJSON]) async throws {
    try await work { revision in
      guard let p = proposal, !done, !selections.isEmpty, selections.allSatisfy({ (1...1_000_000).contains($0["quantity"].integer) }) else { throw CommerceFailure(422, "Choose at least one item with a valid quantity") }
      let value = try await client.proposeReorder(task: p["draft"]["task_id"].string ?? "", order: p["draft"]["order_id"].string ?? "", location: p["draft"]["location_id"].string ?? "", selections: selections); try check(revision); proposal = value
      try await client.saveReorderTask(p["draft"]["order_id"].string ?? "", task: ReorderTask(task: p["draft"]["task_id"].string ?? "", pending: false)); try check(revision); pending = false
    }
  }
  public func approve() async throws {
    try await work { revision in
      guard let order, let task, let id = proposal?["id"].string else { throw CommerceFailure(409, "Review a basket first") }
      let fresh = try await client.assistantProposal(id); try check(revision); proposal = fresh
      if !fresh["applied"].bool {
        let format = ISO8601DateFormatter(); format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let expiry = fresh["expires_at"].string ?? ""
        let date = format.date(from: expiry) ?? ISO8601DateFormatter().date(from: expiry)
        guard fresh["can_apply"].bool, (date ?? .distantPast) > Date(), fresh["execution"]["verdict"].string == nil || fresh["execution"]["verdict"].string == "pass" else { throw CommerceFailure(409, "This proposal needs a fresh review") }
        try await client.saveReorderTask(order.id, task: ReorderTask(task: task.task, pending: true)); try check(revision); pending = true; checkout.invalidate()
        let applied = try await client.applyAssistantProposal(id); try check(revision); accept(applied)
      }
      let cart = try await client.cart(); try check(revision); accept(cart)
      try await client.saveReorderTask(order.id, task: ReorderTask(task: task.task, pending: false)); try check(revision)
      self.cart = cart; done = true; pending = false
    }
  }
}
