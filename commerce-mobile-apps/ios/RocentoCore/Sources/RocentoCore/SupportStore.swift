import Foundation

public let supportCategories = ["order_issue", "product_question", "complaint", "payment_dispute", "other"]
public func supportTextValid(_ value: String, max: Int) -> Bool { !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && value.utf8.count <= max }
public struct SupportInput: Codable, Equatable, Sendable {
  public var request_id = UUID().uuidString
  public var subject = ""
  public var category = "other"
  public var body = ""
  public var order_id: String?
  public var contact_name: String?
  public var contact: String?
  public init() {}
  public func valid(signedIn: Bool) -> Bool { supportTextValid(subject, max: 160) && supportTextValid(body, max: 2000) && supportCategories.contains(category) && (signedIn || (order_id == nil && supportTextValid(contact_name ?? "", max: 100) && supportTextValid(contact ?? "", max: 254))) }
}
public struct SupportTicket: Codable, Identifiable, Sendable {
  public let id: String
  public let number: Int
  public let subject: String
  public let category: String
  public let status: String
  public let priority: String
  public let order_id: String?
  public let created_at: String
}
public struct SupportMessage: Codable, Identifiable, Sendable { public let id: String; public let sender: String; public let body: String; public let created_at: String }
public struct SupportDetail: Codable, Sendable { public let ticket: SupportTicket; public let messages: [SupportMessage] }
public struct SupportReply: Sendable { public let id: String; public let requestID: String; public let body: String }
@MainActor public final class SupportStore {
  public private(set) var draft = SupportInput()
  public private(set) var attempt: SupportInput?
  public private(set) var reply = ""
  public private(set) var replyAttempt: SupportReply?
  public private(set) var tickets: [SupportTicket] = []
  public private(set) var detail: SupportDetail?
  public private(set) var selected: String?
  public private(set) var busy = false
  public private(set) var loaded = false
  public private(set) var failed = false
  public private(set) var created = false
  public private(set) var replied = false
  public private(set) var composing = false
  public var onChange: (() -> Void)?
  private var replies: [String: String] = [:]
  private var generation = 0
  private let client: CommerceClient
  public init(client: CommerceClient) { self.client = client }
  public func reset() { generation += 1; draft = SupportInput(); attempt = nil; reply = ""; replyAttempt = nil; tickets = []; detail = nil; selected = nil; busy = false; loaded = false; failed = false; created = false; replied = false; composing = false; replies = [:]; onChange?() }
  public func edit(_ value: SupportInput) { guard !busy, attempt == nil else { return }; draft = value; onChange?() }
  public func editReply(_ value: String) { guard !busy, replyAttempt == nil else { return }; reply = value; if let selected { replies[selected] = value }; replied = false; onChange?() }
  public func compose(order: String? = nil) { guard !busy else { return }; composing = true; created = false; if attempt == nil, let order { draft.order_id = order }; onChange?() }
  public func showList() { guard !busy else { return }; composing = false; selected = nil; detail = nil; onChange?() }
  private func check(_ revision: Int) throws { guard revision == generation, !Task.isCancelled else { throw CancellationError() } }
  private func work(_ operation: (Int) async throws -> Void) async throws {
    guard !busy else { return }; let revision = generation; busy = true; failed = false; onChange?()
    defer { if revision == generation { busy = false; onChange?() } }
    do { try await operation(revision) } catch { if revision == generation { failed = true }; throw error }
  }
  public func refresh() async throws { try await work { revision in let items = try await client.supportTickets(); try check(revision); tickets = items; loaded = true } }
  public func open(_ id: String) async throws { try await work { revision in selected = id; detail = nil; composing = false; reply = replies[id] ?? ""; created = false; replied = false; onChange?(); let value = try await client.supportDetail(id); try check(revision); detail = value } }
  public func create(signedIn: Bool) async throws { try await work { revision in
    guard attempt != nil || draft.valid(signedIn: signedIn) else { throw CommerceFailure(422, "Complete the support form") }
    let input = attempt ?? draft; attempt = input; onChange?()
    do { let value = try await client.createSupport(input); try check(revision); detail = value; selected = value.ticket.id; created = true; composing = false; attempt = nil; draft = SupportInput(); reply = ""; tickets.removeAll { $0.id == value.ticket.id }; tickets.insert(value.ticket, at: 0) }
    catch { try check(revision); if let failure = error as? CommerceFailure, [400,422].contains(failure.status) { attempt = nil }; throw error }
  } }
  public func sendReply() async throws { try await work { revision in
    guard let id = selected, detail != nil, replyAttempt == nil || replyAttempt?.id == id else { throw CommerceFailure(409, "Return to the pending reply before sending another") }
    guard replyAttempt != nil || supportTextValid(reply, max: 2000) else { throw CommerceFailure(422, "Enter a message within 2000 bytes") }
    let input = replyAttempt ?? SupportReply(id: id, requestID: UUID().uuidString, body: reply); replyAttempt = input; onChange?()
    do { let value = try await client.replySupport(id, requestID: input.requestID, body: input.body); try check(revision); detail = value; reply = ""; replies[id] = nil; replyAttempt = nil; replied = true }
    catch { try check(revision); if let failure = error as? CommerceFailure, [400,422].contains(failure.status) { replyAttempt = nil }; throw error }
  } }
}
