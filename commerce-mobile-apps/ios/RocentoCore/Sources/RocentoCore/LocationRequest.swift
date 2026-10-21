import Foundation

/// Identifies one location lookup so cancellation/replacement rejects late callbacks.
public struct LocationRequest: Sendable {
  public private(set) var active: UUID?
  public init() {}
  @discardableResult public mutating func begin() -> UUID {
    let id = UUID(); active = id; return id
  }
  public func accepts(_ id: UUID) -> Bool { active == id }
  public mutating func cancel() { active = nil }
}
