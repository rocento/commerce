import Foundation

/// Cross-feature workflows run inside the caller's existing operation gate.
/// Dependencies are supplied by the session composition root, never by screens.
@MainActor public final class ShoppingWorkflows {
  private let restoreAccount: @MainActor () async throws -> Bool
  private let recoverySteps: [@MainActor () async throws -> Void]
  private let revision: @MainActor () -> Int
  private let saveItem: @MainActor (String) async throws -> Void
  private let refreshWishlist: @MainActor () async throws -> Void
  public init(restoreAccount: @escaping @MainActor () async throws -> Bool,
              recoverySteps: [@MainActor () async throws -> Void], revision: @escaping @MainActor () -> Int,
              saveItem: @escaping @MainActor (String) async throws -> Void,
              refreshWishlist: @escaping @MainActor () async throws -> Void) {
    self.restoreAccount = restoreAccount; self.recoverySteps = recoverySteps
    self.revision = revision; self.saveItem = saveItem; self.refreshWishlist = refreshWishlist
  }
  public func recover() async throws {
    if try await restoreAccount() { try await reload() }
  }
  public func reload() async throws {
    let expected = revision()
    for step in recoverySteps {
      guard expected == revision() else { throw CancellationError() }
      try await step()
      guard expected == revision() else { throw CancellationError() }
    }
  }
  public func saveForLater(_ id: String) async throws {
    let expected = revision()
    try await saveItem(id)
    guard expected == revision() else { throw CancellationError() }
    try await refreshWishlist()
  }
}
