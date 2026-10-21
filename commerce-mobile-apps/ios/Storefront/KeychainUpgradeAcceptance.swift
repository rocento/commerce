#if DEBUG
import Foundation
import Security
import SwiftUI
import RocentoCore

/// Explicit signed-device acceptance only. Synthetic identity, no network fallback.
struct KeychainUpgradeView: View {
  let phase: String
  @State private var result = "Running"
  var body: some View {
    Text(result).accessibilityIdentifier("keychain-upgrade-result")
      .task {
        do { try await KeychainUpgradeAcceptance.run(phase); result = "PASS " + phase }
        catch { result = "FAIL " + phase } // Never render credentials or response bodies.
      }
  }
}

enum KeychainUpgradeAcceptance {
  static let first = String(repeating: "a", count: 64)
  static let rotated = String(repeating: "b", count: 64)
  static let orderKey = "90000000-0000-0000-0000-000000000001"
  static let reorderKey = "90000000-0000-0000-0000-000000000002"
  static func require(_ condition: Bool) throws {
    guard condition else { throw MobileFailure.invalidResponse }
  }
  static func run(_ phase: String) async throws {
    try require(["seed", "restore", "finish"].contains(phase))
    let identity = try AppIdentity(merchantID: "00000000-0000-0000-0000-000000000001",
      environment: "staging", commerceBaseURL: URL(string: "https://keychain-upgrade.example.test/api")!)
    let raw = ProcessInfo.processInfo.environment["ROCENTO_TEST_COMMERCE"] ?? ""
    let fixture = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as! [String: Any]
    let ids = fixture["ids"] as! [String: String]
    let credentials = SecureSession(identity: identity, purpose: "customer-refresh")
    let attempts = SecureSession(identity: identity, purpose: "checkout-attempt")
    let reorders = SecureSession(identity: identity, purpose: "reorder-task")
    let deletion = SecureSession(identity: identity, purpose: "account-deletion")
    if phase == "seed" {
      // Independently encode the established pre-upgrade storage contract. Never
      // overwrite a pre-existing item or delete data to make a test succeed.
      try legacyInsert(first, identity: identity, purpose: "customer-refresh")
      try legacyInsert("synthetic-deletion-receipt", identity: identity, purpose: "account-deletion")
      let pending: [String: Any] = [ids["customer"]!: ["customerID": ids["customer"]!, "quote": fixture["quote"]!, "key": orderKey]]
      try legacyInsert(String(decoding: JSONSerialization.data(withJSONObject: pending), as: UTF8.self), identity: identity, purpose: "checkout-attempt")
      let reorder: [String: Any] = [ids["customer"]! + ":" + ids["order"]!: ["task": reorderKey, "pending": true]]
      try legacyInsert(String(decoding: JSONSerialization.data(withJSONObject: reorder), as: UTF8.self), identity: identity, purpose: "reorder-task")
    }
    try require(try deletion.readChecked() == "synthetic-deletion-receipt")
    let oldCredential = try credentials.readChecked()
    try require(oldCredential == first || oldCredential == rotated)
    let transport = UpgradeCommerceTransport(fixture: raw, refresh: oldCredential!, key: orderKey)
    let client = CommerceClient(identity: identity, credentials: credentials, attempts: attempts,
      transport: transport, reorders: reorders)
    let customer = try await client.restore()
    try require(customer.id == ids["customer"])
    try require(try credentials.readChecked() == rotated)
    let pending = try await client.pendingCheckout()
    try require(pending?.key == orderKey && pending?.quote.id == ids["quote"])
    let reorder = try await client.reorderTask(ids["order"]!)
    try require(reorder.task == reorderKey && reorder.pending)
    try await verifyUpgradeConfiguration(identity: identity, phase: phase)
    if phase == "finish" {
      _ = try await client.place(pending!.quote)
      try require(try await client.pendingCheckout() == nil)
      try await client.logout()
      try require(try credentials.readChecked() == nil)
      try require(try deletion.readChecked() == "synthetic-deletion-receipt")
      // Logout must not discard a pending reorder.
      try require(try reorders.readChecked() != nil)
    }
  }
  private static func legacyInsert(_ value: String, identity: AppIdentity, purpose: String) throws {
    let origin = identity.commerceBaseURL.absoluteString
    let cache = ConfigValidation.digest(Data("\(identity.merchantID)|\(identity.environment)|ios|\(origin)".utf8))
    let account = cache + "|" + purpose + "|" + ConfigValidation.digest(Data(origin.utf8))
    let status = SecItemAdd([
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "com.rocento.mobile.session", kSecAttrAccount as String: account,
      kSecValueData as String: Data(value.utf8),
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ] as CFDictionary, nil)
    try require(status == errSecSuccess)
  }
}

private actor UpgradeCommerceTransport: HTTPTransport {
  let fixture: String
  let refresh: String
  let key: String
  init(fixture: String, refresh: String, key: String) { self.fixture = fixture; self.refresh = refresh; self.key = key }
  func get(_ request: URLRequest, maxBytes: Int) async throws -> HTTPResult {
    try KeychainUpgradeAcceptance.require(request.url?.host == "keychain-upgrade.example.test")
    let data = try JSONSerialization.jsonObject(with: Data(fixture.utf8)) as! [String: Any]
    let path = request.url!.path
    let value: Any
    var headers: [String: String] = [:]
    if path == "/api/v1/customer/auth/refresh" {
      try KeychainUpgradeAcceptance.require(request.value(forHTTPHeaderField: "Cookie") == "customer_refresh=" + refresh)
      value = data["auth"]!
      headers["Set-Cookie"] = "customer_refresh=\(KeychainUpgradeAcceptance.rotated); Secure; HttpOnly"
    } else if path == "/api/v1/customer/checkout/place" {
      let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
      try KeychainUpgradeAcceptance.require(body["idempotency_key"] as? String == key)
      value = data["detail"]!
    } else if path == "/api/v1/customer/auth/logout" { value = [:] as [String: String] }
    else { throw MobileFailure.invalidResponse }
    return HTTPResult(status: 200, headers: headers, body: try JSONSerialization.data(withJSONObject: value))
  }
}
#endif
