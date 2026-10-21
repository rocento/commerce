import Foundation

/// Local guidance only; the service remains authoritative for identity and password policy.
public enum AccountForm {
  public static func issue(mode: String, identifier: String, password: String, confirmation: String, code: String) -> String? {
    let value = identifier.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !value.isEmpty else { return "identifier" }
    if mode == "login" && password.isEmpty { return "password" }
    if mode == "register" || mode == "reset-password" {
      guard (12...128).contains(password.utf8.count) else { return "length" }
      guard password == confirmation else { return "confirmation" }
    }
    if (mode == "verify" || mode == "reset-password") && code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "code" }
    return nil
  }
  public static func next(_ mode: String) -> String {
    switch mode {
    case "register": return "verify"
    case "forgot-password": return "reset-password"
    case "verify", "reset-password": return "login"
    default: return mode
    }
  }
}

/// Ephemeral form state. Never persist credentials or verification codes.
public struct AuthenticationFormState: Equatable, Sendable {
  public var mode = "login"
  public var identifier = ""
  public var password = ""
  public var confirmation = ""
  public var code = ""
  public var showPassword = false
  public var validation: String?
  private var revision = UUID()
  public init() {}
  public mutating func open(_ mode: String) {
    self.mode = mode; clearSecrets()
  }
  public mutating func clearSecrets() {
    password = ""; confirmation = ""; code = ""; showPassword = false; validation = nil
    revision = UUID()
  }
  public mutating func validate() -> Bool {
    validation = AccountForm.issue(mode: mode, identifier: identifier, password: password, confirmation: confirmation, code: code)
    return validation == nil
  }
  @discardableResult public mutating func complete(_ submitted: Self) -> Bool {
    guard self == submitted else { return false }
    open(AccountForm.next(submitted.mode)); return true
  }
}
