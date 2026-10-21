import Foundation
import Security

protocol KeychainWriting: Sendable {
  func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus
  func add(_ attributes: [String: Any]) -> OSStatus
  func delete(_ query: [String: Any]) -> OSStatus
}

private struct SystemKeychainWriter: KeychainWriting {
  func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus {
    SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
  }
  func add(_ attributes: [String: Any]) -> OSStatus { SecItemAdd(attributes as CFDictionary, nil) }
  func delete(_ query: [String: Any]) -> OSStatus { SecItemDelete(query as CFDictionary) }
}

public struct SecureSession: Sendable {
  let account: String
  private let writer: any KeychainWriting
  public init(identity: AppIdentity, purpose: String) {
    self.init(identity: identity, purpose: purpose, writer: SystemKeychainWriter())
  }
  init(identity: AppIdentity, purpose: String, writer: any KeychainWriting) {
    account = identity.cacheKey + "|" + purpose + "|" + ConfigValidation.digest(Data(identity.commerceBaseURL.absoluteString.utf8))
    self.writer = writer
  }
  private var query: [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "com.rocento.mobile.session", kSecAttrAccount as String: account,
    ]
  }
  public func read() -> String? {
    var q = query
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess,
      let data = result as? Data
    else { return nil }
    return String(data: data, encoding: .utf8)
  }
  public func save(_ token: String?) throws {
    guard let token else {
      let status = writer.delete(query)
      guard status == errSecSuccess || status == errSecItemNotFound else { throw MobileFailure.unauthorized }
      return
    }
    try savePreserving(token)
  }
  public func readChecked() throws -> String? {
    var q = query; q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data, let value = String(data: data, encoding: .utf8) else { throw MobileFailure.unauthorized }
    return value
  }
  // Credentials and recovery records must survive a failed update of an existing item.
  public func savePreserving(_ value: String) throws {
    let attributes = [kSecValueData as String: Data(value.utf8)]
    let status = writer.update(query, attributes: attributes)
    if status == errSecSuccess { return }
    guard status == errSecItemNotFound else { throw MobileFailure.unauthorized }
    var q = query; q[kSecValueData as String] = Data(value.utf8); q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    guard writer.add(q) == errSecSuccess else { throw MobileFailure.unauthorized }
  }
}
