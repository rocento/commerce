import Foundation

@MainActor public final class ProductPromptStore {
  public private(set) var products: [Product] = [] { didSet { onChange?() } }
  public private(set) var selected: Set<String> = [] { didSet { onChange?() } }
  public private(set) var loading = false { didSet { onChange?() } }
  public private(set) var failed = false { didSet { onChange?() } }
  public var onChange: (() -> Void)?
  private var generation = 0
  public init() {}
  public func reset() { generation += 1; products = []; selected = []; loading = false; failed = false }
  public func select(_ id: String, enabled: Bool) {
    guard products.contains(where: { $0.id == id }) else { return }
    if enabled { selected.insert(id) } else { selected.remove(id) }
  }
  public func load(_ fetch: () async throws -> [Product]) async {
    generation += 1; let revision = generation; loading = true; failed = false; products = []; selected = []
    defer { if generation == revision { loading = false } }
    do {
      let values = try await fetch()
      guard generation == revision, !Task.isCancelled else { return }
      products = Array(values.filter { $0.active != false }.prefix(8))
    } catch { if generation == revision, !Task.isCancelled { failed = true } }
  }
}
