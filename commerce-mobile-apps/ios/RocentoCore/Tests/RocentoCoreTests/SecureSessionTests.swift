import Security
import XCTest

@testable import RocentoCore

private final class KeychainWriterSpy: KeychainWriting, @unchecked Sendable {
  private let lock = NSLock()
  private var recorded: [String] = []
  private var stored: Data?
  let updateStatus: OSStatus
  let deleteStatus: OSStatus
  init(value: String? = nil, updateStatus: OSStatus = errSecSuccess, deleteStatus: OSStatus = errSecSuccess) {
    stored = value.map { Data($0.utf8) }
    self.updateStatus = updateStatus
    self.deleteStatus = deleteStatus
  }
  var operations: [String] { lock.lock(); defer { lock.unlock() }; return recorded }
  var value: String? { lock.lock(); defer { lock.unlock() }; return stored.flatMap { String(data: $0, encoding: .utf8) } }
  func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus {
    lock.lock(); defer { lock.unlock() }
    recorded.append("update")
    if updateStatus == errSecSuccess { stored = attributes[kSecValueData as String] as? Data }
    return updateStatus
  }
  func add(_ attributes: [String: Any]) -> OSStatus {
    lock.lock(); defer { lock.unlock() }
    recorded.append("add")
    XCTAssertEqual(attributes[kSecAttrService as String] as? String, "com.rocento.mobile.session")
    XCTAssertEqual(attributes[kSecAttrAccessible as String] as? String, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
    stored = attributes[kSecValueData as String] as? Data
    return errSecSuccess
  }
  func delete(_ query: [String: Any]) -> OSStatus {
    lock.lock(); defer { lock.unlock() }
    recorded.append("delete")
    if deleteStatus == errSecSuccess { stored = nil }
    return deleteStatus
  }
}

final class SecureSessionTests: XCTestCase {
  private func session(_ writer: KeychainWriterSpy) throws -> SecureSession {
    let identity = try AppIdentity(merchantID: "70000000-0000-0000-0000-000000000001",
      environment: "production", commerceBaseURL: URL(string: "https://grocery.example.test/api")!)
    return SecureSession(identity: identity, purpose: "customer-refresh", writer: writer)
  }
  func testFailedUpdatePreservesExistingCredential() throws {
    let writer = KeychainWriterSpy(value: "existing", updateStatus: errSecInteractionNotAllowed)
    XCTAssertThrowsError(try session(writer).save("replacement"))
    XCTAssertEqual(writer.value, "existing")
    XCTAssertEqual(writer.operations, ["update"])
  }
  func testReplacementUpdatesWithoutDeletingItem() throws {
    let writer = KeychainWriterSpy(value: "existing")
    try session(writer).save("replacement")
    XCTAssertEqual(writer.value, "replacement")
    XCTAssertEqual(writer.operations, ["update"])
  }
  func testMissingItemIsAddedWithExistingStorageContract() throws {
    let writer = KeychainWriterSpy(updateStatus: errSecItemNotFound)
    try session(writer).save("new")
    XCTAssertEqual(writer.value, "new")
    XCTAssertEqual(writer.operations, ["update", "add"])
  }
  func testDeletionFailureIsReportedAndMissingItemIsAlreadyDeleted() throws {
    let writer = KeychainWriterSpy(value: "existing", deleteStatus: errSecInteractionNotAllowed)
    XCTAssertThrowsError(try session(writer).save(nil))
    XCTAssertEqual(writer.value, "existing")
    XCTAssertEqual(writer.operations, ["delete"])
    XCTAssertNoThrow(try session(KeychainWriterSpy(deleteStatus: errSecItemNotFound)).save(nil))
  }
}
