import Foundation

public protocol WishlistServing: Sendable {
  func wishlist() async throws -> [String]
  func product(id: String, locale: String) async throws -> Product
  func saveProduct(_ id: String, saved: Bool) async throws
}
extension CommerceClient: WishlistServing {}

public struct WishlistState {
  public var ids: [String] = []
  public var products: [String: Product] = [:]
  public var resolved: Set<String> = []
  public var limit = 24
  public var loaded = false
  public var loading = false
  public var failed = false
  public var locale: String?
}
@MainActor public final class WishlistStore {
  public private(set) var state = WishlistState() { didSet { onChange?() } }
  public var onChange: (() -> Void)?
  private let client: any WishlistServing
  private var generation = 0
  public init(client: any WishlistServing) { self.client = client }
  public func reset() { generation += 1; state = WishlistState() }
  public func invalidate() { generation += 1; state.loaded = false; state.loading = false }
  private func check(_ revision: Int) throws { guard revision == generation, !Task.isCancelled else { throw CancellationError() } }
  private func run(_ operation: (Int) async throws -> Void) async throws {
    generation += 1; let revision = generation; state.loading = true; state.failed = false
    defer { if generation == revision { state.loading = false } }
    do { try await operation(revision) }
    catch { try check(revision); state.failed = true; throw error }
  }
  public func refreshIDs() async throws {
    try await run { revision in
      let ids = try await client.wishlist(); try check(revision)
      var seen: Set<String> = []; state.ids = ids.filter { seen.insert($0).inserted }
      state.products = state.products.filter { state.ids.contains($0.key) }; state.resolved.formIntersection(state.ids)
    }
  }
  public func load(locale: String, more: Bool = false) async throws {
    if state.locale != locale { state.locale = locale; state.products = [:]; state.resolved = []; state.loaded = false; state.limit = 24 }
    let limit = more ? state.limit + 24 : 24
    try await run { revision in
      let all = try await client.wishlist(); try check(revision)
      var seen: Set<String> = []; let ids = all.filter { seen.insert($0).inserted }
      let visible = Set(ids.prefix(limit))
      let reusable = more && state.loaded ? state.resolved.intersection(visible) : []
      var products = state.products.filter { reusable.contains($0.key) }
      let fetched: [(String, Product?)] = try await concurrentReads(ids.prefix(limit).filter { !reusable.contains($0) }) { [self, client] id in
        try await check(revision)
        let product: Product?
        do { product = try await client.product(id: id, locale: locale) }
        catch let failure as CommerceFailure where failure.status == 404 { product = nil }
        try await check(revision)
        return (id, product)
      }
      try check(revision)
      for (id, product) in fetched { if let product, product.active != false { products[id] = product } }
      state.ids = ids; state.products = products; state.resolved = visible; state.limit = limit; state.loaded = true
    }
  }
  public func save(_ id: String, saved: Bool, product: Product? = nil) async throws {
    try await run { revision in
      try await client.saveProduct(id, saved: saved); try check(revision)
      state.ids.removeAll { $0 == id }
      if saved { state.ids.insert(id, at: 0); if let product { state.products[id] = product; state.resolved.insert(id) } }
      else { state.products[id] = nil; state.resolved.remove(id) }
    }
  }
}
