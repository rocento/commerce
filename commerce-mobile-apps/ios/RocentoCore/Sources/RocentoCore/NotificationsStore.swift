import Foundation

@MainActor public protocol NotificationPreferences: AnyObject {
  var orderUpdates: Bool { get set }
  func readIDs(owner: String) -> Set<String>
  func setReadIDs(_ ids: Set<String>, owner: String)
}
@MainActor public final class MemoryNotificationPreferences: NotificationPreferences {
  public var orderUpdates = true
  private var read: [String: Set<String>] = [:]
  public init() {}
  public func readIDs(owner: String) -> Set<String> { read[owner] ?? [] }
  public func setReadIDs(_ ids: Set<String>, owner: String) { read[owner] = ids }
}
public protocol NotificationsServing: Sendable {
  func orders(offset: Int) async throws -> [CustomerOrder]
  func order(_ id: String) async throws -> CustomerOrderDetail
}
extension CommerceClient: NotificationsServing {}
public struct InboxUpdate: Identifiable {
  public let id: String; public let order: String; public let number: Int64; public let status: String; public let date: String
}
public struct NotificationsState {
  public var owner: String?
  public var details: [CustomerOrderDetail] = []
  public var read: Set<String> = []
  public var enabled = true
  public var unreadOnly = false
  public var loading = false
  public var loaded = false
  public var failed = false
  public var offset = 0
  public var hasMore = false
  public var events: [InboxUpdate] {
    var seen: Set<String> = []
    var result: [InboxUpdate] = []
    for detail in details {
      for history in detail.history {
        let id = "\(detail.order.id):\(history.id)"
        if seen.insert(id).inserted {
          result.append(InboxUpdate(id: id, order: detail.order.id, number: detail.order.number, status: history.status, date: history.created_at))
        }
      }
    }
    return result.sorted { $0.date == $1.date ? $0.id < $1.id : $0.date > $1.date }
  }
  public var unread: [InboxUpdate] { events.filter { !read.contains($0.id) } }
}
@MainActor public final class NotificationsStore {
  public private(set) var state = NotificationsState() { didSet { onChange?() } }
  public var onChange: (() -> Void)?
  private let client: any NotificationsServing
  private let preferences: any NotificationPreferences
  private var generation = 0
  public init(client: any NotificationsServing, preferences: any NotificationPreferences) {
    self.client = client; self.preferences = preferences; state.enabled = preferences.orderUpdates
  }
  public func reset() { generation += 1; state = NotificationsState(); state.enabled = preferences.orderUpdates }
  public func bind(_ owner: String?) {
    guard state.owner != owner else { return }; reset(); state.owner = owner
    if let owner { state.read = preferences.readIDs(owner: owner) }
  }
  public func setEnabled(_ value: Bool) { preferences.orderUpdates = value; generation += 1; state.enabled = value; state.loading = false }
  public func filterUnread(_ value: Bool) { state.unreadOnly = value }
  public func mark(_ ids: [String]) {
    guard let owner = state.owner else { return }
    state.read.formUnion(Set(ids).intersection(state.events.map(\.id))); preferences.setReadIDs(state.read, owner: owner)
  }
  private func check(_ revision: Int) throws { guard generation == revision, !Task.isCancelled else { throw CancellationError() } }
  public func refresh(owner: String, more: Bool = false) async throws {
    bind(owner); guard state.enabled, !more || (state.hasMore && !state.loading) else { return }
    generation += 1; let revision = generation, offset = more ? state.offset : 0
    state.loading = true; state.failed = false
    defer { if generation == revision { state.loading = false } }
    do {
      let orders = try await client.orders(offset: offset); try check(revision)
      let details = try await concurrentReads(orders) { [self, client] order in
        try await check(revision)
        let detail = try await client.order(order.id)
        try await check(revision)
        return detail
      }
      try check(revision)
      var seen: Set<String> = []
      state.details = (more ? state.details + details : details).filter { seen.insert($0.order.id).inserted }
      state.offset = offset + orders.count; state.hasMore = !orders.isEmpty && state.offset <= 9999; state.loaded = true
    } catch { try check(revision); state.failed = true; throw error }
  }
}
