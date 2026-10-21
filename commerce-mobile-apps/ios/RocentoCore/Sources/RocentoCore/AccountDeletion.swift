import Foundation

public struct AccountRetentionPolicy: Codable, Sendable {
  public let id: String
  public let legal_entity: String
  public let jurisdictions: [String]
  public let financial_days: Int
  public let retain_contact: Bool
  public let retain_address: Bool
}
public struct AccountDeletionReceipt: Codable, Sendable {
  public let request_id: String
  public let receipt_token: String
  public let customer_id: String
  public let policy_id: String
}
public struct AccountDeletionStatus: Codable, Sendable {
  public let id: String
  public let state: String
  public let waiting_reason: String?
  public let retained_until: String?
}

/// Server acceptance is durable even when local secure-storage cleanup needs retry.
public struct AccountDeletionCleanupFailure: Error, Sendable {
  public let status: AccountDeletionStatus
}
