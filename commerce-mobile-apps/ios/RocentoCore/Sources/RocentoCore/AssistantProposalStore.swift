import Foundation

@MainActor public final class AssistantProposalStore {
  public enum Issue { case load, unconfirmed, apply }
  public private(set) var proposal: AssistantJSON? { didSet { onChange?() } }
  public private(set) var busy = false { didSet { onChange?() } }
  public private(set) var pending = false { didSet { onChange?() } }
  public private(set) var issue: Issue? { didSet { onChange?() } }
  public var onChange: (() -> Void)?
  private let fetch: () async throws -> AssistantJSON
  private var generation = 0
  public init(fetch: @escaping () async throws -> AssistantJSON) { self.fetch = fetch }
  public func reset() { generation += 1; proposal = nil; busy = false; pending = false; issue = nil }
  public var canApply: Bool {
    guard let p = proposal else { return false }
    let format = ISO8601DateFormatter(); format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let expiry = p["expires_at"].string ?? ""
    let date = format.date(from: expiry) ?? ISO8601DateFormatter().date(from: expiry)
    return p["can_apply"].bool && !p["applied"].bool && (date ?? .distantPast) > Date()
      && (p["execution"]["verdict"].string == nil || p["execution"]["verdict"].string == "pass")
      && (p["draft"]["mode"].string != "buy_again" || p["draft"]["location_id"].string.flatMap(UUID.init(uuidString:)) != nil)
  }
  public func reload(settled: () async -> Void) async {
    guard !busy else { return }; let revision = generation; busy = true; issue = nil
    defer { if generation == revision { busy = false } }
    do {
      let value = try await fetch()
      guard generation == revision, !Task.isCancelled else { return }
      proposal = value
      if value["applied"].bool { pending = false; await settled() }
      else if pending { issue = .unconfirmed }
    } catch { if generation == revision, !Task.isCancelled { issue = .load } }
  }
  public func apply(locked: Bool, operation: (String?) async throws -> Void, settled: () async -> Void) async {
    guard !busy, !locked else { return }
    if pending { await reload(settled: settled); return }
    guard canApply else { return }
    let revision = generation; busy = true; pending = true; issue = nil
    do { try await operation(proposal?["draft"]["location_id"].string) }
    catch { if generation == revision { issue = .apply } }
    guard generation == revision else { return }; busy = false
    if !Task.isCancelled { await reload(settled: settled) }
  }
}
