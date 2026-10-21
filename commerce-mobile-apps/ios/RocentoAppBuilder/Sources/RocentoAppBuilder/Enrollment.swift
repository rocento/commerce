import Foundation
import RocentoCore

private struct DeviceSession: Decodable, Sendable {
  let deviceId: String
  let deviceToken: String?
  let accessToken: String
  let expiresIn: Int
  let merchantId: String
  let platform: String
  let identifier: String
  let environment: String
}
/// Internal installations enroll with an owner-issued, one-use invitation.
/// This credential grants published configuration reads, never customer/admin access.
public actor EnrollmentClient {
  let identity: AppBuilderIdentity
  let identifier: String
  let storage: any CredentialStorage
  let transport: any HTTPTransport
  private var access: String?
  private var expires = Date.distantPast
  private var pending: Task<String?, Error>?
  public init(
    identity: AppBuilderIdentity, identifier: String, storage: any CredentialStorage,
    transport: any HTTPTransport = URLSessionTransport()
  ) {
    self.identity = identity
    self.identifier = identifier
    self.storage = storage
    self.transport = transport
  }
  public func connected() -> Bool { storage.read() != nil }
  public func enroll(code: String) async throws {
    try Task.checkCancellation()
    guard pending == nil else { throw MobileFailure.invalidResponse }
    let code = code.trimmingCharacters(in: .whitespacesAndNewlines)
    guard code.count == 64, code.allSatisfy(\.isHexDigit) else {
      throw MobileFailure.invalidResponse
    }
    let task = Task<String?, Error> {
      let result = try await self.exchange("enroll", credential: ["code": code])
      guard let device = result.deviceToken, device.utf8.count == 64,
        device.allSatisfy({ "0123456789abcdefABCDEF".contains($0) })
      else { throw MobileFailure.invalidResponse }
      try self.storage.save(device)
      self.accept(result)
      return result.accessToken
    }
    pending = task
    defer { pending = nil }
    _ = try await ownedValue(task)
  }
  public func token() async throws -> String? {
    try Task.checkCancellation()
    if let pending {
      let value = try await pending.value
      try Task.checkCancellation()
      return value
    }
    if let access, expires > Date() { return access }
    guard let device = storage.read() else { return nil }
    let task = Task<String?, Error> {
      do {
        let result = try await self.exchange("session", credential: ["deviceToken": device])
        self.accept(result)
        return result.accessToken
      } catch MobileFailure.unauthorized {
        try self.storage.save(nil)
        self.clearAccess()
        throw MobileFailure.unauthorized
      }
    }
    pending = task
    defer { pending = nil }
    return try await ownedValue(task)
  }
  // Propagate the initiating caller's cancellation into the shared exchange task.
  // A cancelled exchange leaves the saved credential intact for the next refresh.
  private func ownedValue(_ task: Task<String?, Error>) async throws -> String? {
    do {
      return try await withTaskCancellationHandler {
        let value = try await task.value
        try Task.checkCancellation()
        return value
      } onCancel: { task.cancel() }
    } catch {
      try rethrowBuilderCancellation(error)
      throw error
    }
  }
  private func accept(_ result: DeviceSession) {
    access = result.accessToken
    expires = Date().addingTimeInterval(Double(result.expiresIn - 60))
  }
  private func clearAccess() {
    access = nil
    expires = .distantPast
  }
  private func exchange(_ path: String, credential: [String: String]) async throws -> DeviceSession
  {
    try Task.checkCancellation()
    var body = credential
    body["merchantId"] = identity.merchantID
    body["platform"] = "ios"
    body["identifier"] = identifier
    var request = URLRequest(
      url: identity.configBaseURL.appendingPathComponent("v1/mobile/\(path)"))
    request.httpMethod = "POST"
    request.httpBody = try JSONEncoder().encode(body)
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("1", forHTTPHeaderField: "X-Commerce-Request")
    let result = try await transport.get(request, maxBytes: 8192)
    try Task.checkCancellation()
    if [401, 403].contains(result.status) { throw MobileFailure.unauthorized }
    guard result.status == 200 else { throw MobileFailure.invalidResponse }
    let session = try JSONDecoder().decode(DeviceSession.self, from: result.body)
    guard session.merchantId == identity.merchantID, session.platform == "ios",
      session.identifier == identifier, session.environment == identity.environment,
      session.accessToken.utf8.count == 64,
      session.accessToken.allSatisfy({ "0123456789abcdefABCDEF".contains($0) }),
      (120...3600).contains(session.expiresIn),
      UUID(uuidString: session.deviceId) != nil
    else { throw MobileFailure.invalidResponse }
    return session
  }
  public func asset(_ id: String, locale: String) async throws -> Data {
    guard UUID(uuidString: id) != nil, let token = try await token() else {
      throw MobileFailure.unauthorized
    }
    var url = URLComponents(
      url: identity.configBaseURL.appendingPathComponent("v1/mobile/assets/\(id)/content"),
      resolvingAgainstBaseURL: false)!
    url.queryItems = [
      .init(name: "platform", value: "ios"),
      .init(name: "runtimeVersion", value: identity.runtimeVersion),
      .init(name: "locale", value: locale == "ar" ? "ar" : "en"),
    ]
    var request = URLRequest(url: url.url!)
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    let result = try await transport.get(request, maxBytes: 5 * 1024 * 1024)
    try Task.checkCancellation()
    guard result.status == 200, result.header("content-type") == "image/png",
      result.header("x-asset-checksum") == ConfigValidation.digest(result.body)
    else { throw MobileFailure.invalidResponse }
    return result.body
  }
}
