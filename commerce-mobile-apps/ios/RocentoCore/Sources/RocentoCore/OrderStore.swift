import Foundation

/// Customer-scoped order history and details. Independent revisions prevent late reads
/// from replacing a newer page, detail selection, checkout result, or customer session.
@MainActor public final class OrderStore {
  public private(set) var orders: [CustomerOrder] = []
  public private(set) var detail: CustomerOrderDetail?
  public private(set) var loading = false
  public private(set) var detailLoading = false
  public private(set) var failed = false
  public private(set) var detailFailed = false
  public private(set) var loaded = false
  public private(set) var hasMore = true
  public private(set) var selectedID: String?
  public var onChange: (() -> Void)?
  private var offset = 0
  private var listRevision = 0
  private var detailRevision = 0
  private let list: (Int) async throws -> [CustomerOrder]
  private let fetch: (String) async throws -> CustomerOrderDetail
  public init(list: @escaping (Int) async throws -> [CustomerOrder], fetch: @escaping (String) async throws -> CustomerOrderDetail) {
    self.list = list; self.fetch = fetch
  }
  public convenience init(client: any OrderServing) {
    self.init(list: { try await client.orders(offset: $0) }, fetch: { try await client.order($0) })
  }
  public func reset() {
    listRevision += 1; detailRevision += 1; orders = []; detail = nil; selectedID = nil
    offset = 0; loading = false; detailLoading = false; failed = false; detailFailed = false; loaded = false; hasMore = true; onChange?()
  }
  public func show(_ value: CustomerOrderDetail?) {
    detailRevision += 1; detail = value; selectedID = value?.order.id; detailLoading = false; detailFailed = false; onChange?()
  }
  public func setOrders(_ value: [CustomerOrder]) {
    listRevision += 1; orders = unique(value); offset = value.count; loaded = true; loading = false; failed = false; hasMore = !value.isEmpty; onChange?()
  }
  private func unique(_ values: [CustomerOrder]) -> [CustomerOrder] {
    var ids = Set<String>(); return values.filter { ids.insert($0.id).inserted }
  }
  @discardableResult public func refresh(more: Bool = false) async throws -> Int {
    if more && (loading || !hasMore) { return 0 }
    listRevision += 1; let revision = listRevision
    loading = true; failed = false; onChange?()
    do {
      let page = try await list(more ? offset : 0)
      guard revision == listRevision else { throw CancellationError() }
      orders = unique((more ? orders : []) + page); offset = (more ? offset : 0) + page.count
      hasMore = !page.isEmpty; loaded = true; loading = false; onChange?(); return page.count
    } catch {
      guard revision == listRevision else { throw CancellationError() }
      loading = false; failed = !(error is CancellationError); onChange?(); throw error
    }
  }
  public func track(_ id: String) async throws {
    detailRevision += 1; let revision = detailRevision
    if selectedID != id { detail = nil }
    selectedID = id; detailLoading = true; detailFailed = false; onChange?()
    do {
      let result = try await fetch(id)
      guard revision == detailRevision else { throw CancellationError() }
      detail = result; detailLoading = false; onChange?()
    } catch {
      guard revision == detailRevision else { throw CancellationError() }
      detailLoading = false; detailFailed = !(error is CancellationError); onChange?(); throw error
    }
  }
}
