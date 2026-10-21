import Foundation
import RocentoCore

final class MemoryCredential: CredentialStorage, @unchecked Sendable {
  private let lock = NSLock()
  private var value: String?
  init(_ value: String? = nil) { self.value = value }
  func read() -> String? {
    lock.lock()
    defer { lock.unlock() }
    return value
  }
  func save(_ value: String?) throws {
    lock.lock()
    defer { lock.unlock() }
    self.value = value
  }
}
