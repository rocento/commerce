#if DEBUG
import Foundation
import Combine
import RocentoCore

public struct DraftPreviewUpdate: Sendable {
  public let revision: Int
  public let checksum: String
  public let snapshot: ConfigSnapshot
  public init(revision: Int, checksum: String, snapshot: ConfigSnapshot) {
    self.revision = revision; self.checksum = checksum; self.snapshot = snapshot
  }
}

/// Hosting-independent transport: a local or cloud simulator runs the same consumer.
public protocol DraftPreviewTransport: Sendable {
  func snapshot() async throws -> DraftPreviewUpdate
  func acknowledge(_ update: DraftPreviewUpdate) async throws
}

/// Applies validated snapshots on the main actor, then acknowledges the applied revision.
/// No network delivery is ever treated as evidence that a rendered frame was streamed.
@MainActor public final class DraftPreviewRuntime: ObservableObject {
  @Published public private(set) var appliedRevision: Int?
  @Published public private(set) var status = "Not connected"
  private var checksum: String?
  public init() {}

  public func receive(_ update: DraftPreviewUpdate, apply: (ConfigSnapshot) -> Void) throws {
    guard update.revision > 0 else { throw MobileFailure.invalidResponse }
    if let appliedRevision {
      guard update.revision >= appliedRevision else { throw MobileFailure.invalidResponse }
      if update.revision == appliedRevision {
        guard checksum == update.checksum else { throw MobileFailure.invalidResponse }
        return
      }
    }
    apply(update.snapshot)
    appliedRevision = update.revision
    checksum = update.checksum
  }

  public func run(transport: any DraftPreviewTransport, apply: (ConfigSnapshot) -> Void) async {
    var delay: UInt64 = 4
    while !Task.isCancelled {
      do {
        let update = try await transport.snapshot()
        try Task.checkCancellation()
        try receive(update, apply: apply)
        try await transport.acknowledge(update)
        status = "Native applied draft r\(update.revision)"
        delay = 4
      } catch {
        if Task.isCancelled || error is CancellationError || (error as? URLError)?.code == .cancelled { return }
        if case MobileFailure.unauthorized = error {
          status = "Preview session expired or stopped. Last valid design retained."
          return
        }
        status = "Preview reconnecting. Last valid design retained."
        delay = min(delay * 2, 30)
      }
      do { try await Task.sleep(nanoseconds: delay * 1_000_000_000) }
      catch { return }
    }
  }
}

/// Draft state is memory-only and cannot overwrite the published cache.
@MainActor public final class DraftPreviewConfiguration: StorefrontConfiguration {
  private let published: any StorefrontConfiguration
  private var current: ConfigSnapshot?
  public init(published: any StorefrontConfiguration) { self.published = published }
  public func set(_ snapshot: ConfigSnapshot?) { current = snapshot }
  public func refresh(locale: String) async throws -> ConfigSnapshot {
    if let current { return current }
    let result = try await published.refresh(locale: locale)
    // A draft may have arrived while the published request was in flight.
    return current ?? result
  }
}

#endif
