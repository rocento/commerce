import Foundation

public struct HistoryTurn: Decodable, Sendable {
  public let conversation_id: String; public let request_id: String; public let question: String; public let answer: String; public let created_at: String; public let blocks: [AssistantBlock]?
  public static func validate(_ turns: [HistoryTurn]) throws {
    guard turns.count <= 100, Set(turns.map(\.request_id)).count == turns.count else { throw AssistantStreamError.invalid }
    for turn in turns { guard UUID(uuidString: turn.conversation_id) != nil, UUID(uuidString: turn.request_id) != nil, turn.question.count <= 16000, turn.answer.count <= 65536, !turn.created_at.isEmpty, (turn.blocks?.count ?? 0) <= 32 else { throw AssistantStreamError.invalid }; for block in turn.blocks ?? [] { try block.validate() } }
  }
}
public struct SavedConversation: Identifiable { public let id: String; public let title: String; public let updated: String }
public let preferenceAttributes = ["product", "brand", "color", "style", "metal", "material"]
public let memoryOccasions = ["any", "everyday", "gift", "work", "travel"]
public struct MemoryPreferenceInput: Codable, Sendable {
  public var attribute = "product"; public var value = ""; public var category_id = ""; public var occasion = "any"; public var recipient = "self"; public var goal_id: String?; public var dislike = false; public var replaces: String?
  public init() {}
  public func valid(_ view: MemoryView?) -> Bool {
    guard let view, view.personalized, preferenceAttributes.contains(attribute), memoryOccasions.contains(occasion), ["self", "other"].contains(recipient), view.categories.contains(where: { $0.id == category_id }), !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, value.unicodeScalars.count <= 100 else { return false }
    return attribute != "product" || view.products.contains(where: { $0.id == value && $0.category_id == category_id }) || view.preferences.contains(where: { $0.id == replaces && $0.value == value && $0.category_id == category_id })
  }
}
public struct MemoryPreference: Decodable, Identifiable, Sendable {
  public let id: String; public let attribute: String; public let value: String; public let category_id: String; public let occasion: String; public let recipient: String; public let goal_id: String?; public let signal: String
  public var input: MemoryPreferenceInput { var p = MemoryPreferenceInput(); p.attribute = attribute; p.value = value; p.category_id = category_id; p.occasion = occasion; p.recipient = recipient; p.goal_id = goal_id; p.dislike = signal == "explicit_dislike"; p.replaces = id; return p }
}
public struct MemoryCategory: Decodable, Identifiable, Sendable { public let id: String; public let name: String }
public struct MemoryProduct: Decodable, Identifiable, Sendable { public let id: String; public let name: String; public let category_id: String }
public struct MemorySignal: Decodable, Sendable { public let product_id: String; public let name: String; public let kind: String }
public struct MemoryView: Decodable, Sendable {
  public let enabled: Bool; public let guest: Bool; public let personalized: Bool; public let journey_consent: Bool; public let consent_version: Int; public let expires_at: String?; public let preferences: [MemoryPreference]; public let signals: [MemorySignal]; public let categories: [MemoryCategory]; public let products: [MemoryProduct]
}
public struct SavedGoal: Decodable, Identifiable, Sendable { public let task_id: String; public let name: String; public let archived: Bool; public let version: Int; public let state: String?; public let expires_at: String; public var id: String { task_id } }
public func memoryGoalActive(_ goal: SavedGoal) -> Bool { let formatter = ISO8601DateFormatter(); let plain = formatter.date(from: goal.expires_at); formatter.formatOptions.insert(.withFractionalSeconds); return !goal.archived && (plain ?? formatter.date(from: goal.expires_at) ?? .distantPast) > Date() }
public enum MemoryAction: Sendable {
  case consent(personalized: Bool, journey: Bool, version: Int), preference(MemoryPreferenceInput), removePreference(String), clearContext(String), delete, goal(SavedGoal, name: String, archived: Bool), deleteGoal(SavedGoal)
}
@MainActor public final class AssistantLibrary {
  public private(set) var history: [HistoryTurn] = []
  public private(set) var memory: MemoryView?
  public private(set) var goals: [SavedGoal] = []
  public private(set) var draft = MemoryPreferenceInput()
  public private(set) var busy = false
  public private(set) var failed = false
  public private(set) var loaded = false
  public private(set) var needsRefresh = false
  public private(set) var exported: String?
  public private(set) var changed = false
  public var onChange: (() -> Void)?
  private var generation = 0
  private let client: CommerceClient
  public init(client: CommerceClient) { self.client = client }
  public func reset() { generation += 1; history = []; memory = nil; goals = []; draft = MemoryPreferenceInput(); busy = false; failed = false; loaded = false; needsRefresh = false; exported = nil; changed = false; onChange?() }
  public func edit(_ value: MemoryPreferenceInput) { guard !busy, !needsRefresh else { return }; draft = value; onChange?() }
  public func clearExport() { exported = nil; onChange?() }
  public func conversations(_ search: String) -> [SavedConversation] {
    Dictionary(grouping: history, by: \.conversation_id).compactMap { id, values in
      let sorted = values.sorted { $0.created_at < $1.created_at }
      guard let first = sorted.first, let last = sorted.last, search.isEmpty || values.contains(where: { ($0.question + " " + $0.answer).localizedCaseInsensitiveContains(search) }) else { return nil }
      return SavedConversation(id: id, title: first.question, updated: last.created_at)
    }.sorted { $0.updated > $1.updated }
  }
  private func check(_ revision: Int) throws { guard revision == generation, !Task.isCancelled else { throw CancellationError() } }
  private func work(_ operation: (Int) async throws -> Void) async throws { guard !busy else { return }; let revision = generation; busy = true; failed = false; onChange?(); defer { if revision == generation { busy = false; onChange?() } }; do { try await operation(revision) } catch { if revision == generation { failed = true }; throw error } }
  public func refresh(conversation: String, signedIn: Bool) async throws { try await work { revision in
    var failure: Error?
    do { let view = try await client.memoryView(conversation); try check(revision); memory = view; exported = nil }
    catch { try check(revision); failure = error; memory = nil; exported = nil }
    do { let turns = signedIn ? try await client.assistantHistory() : []; try check(revision); history = turns; loaded = true }
    catch { try check(revision); if failure == nil { failure = error } }
    do { let items = signedIn ? try await client.savedGoals() : []; try check(revision); goals = items }
    catch { try check(revision); if failure == nil { failure = error } }
    if let failure { throw failure }; needsRefresh = false
  } }
  public func open(_ id: String, accept: ([HistoryTurn]) throws -> Void) async throws { try await work { revision in
    let turns = try await client.assistantHistory(id).filter { $0.conversation_id.lowercased() == id.lowercased() }.sorted { $0.created_at < $1.created_at }; try check(revision)
    guard !turns.isEmpty else { throw CommerceFailure(404, "This conversation is no longer available") }; try accept(turns)
  } }
  public func mutate(_ action: MemoryAction, conversation: String, signedIn: Bool) async throws {
    guard !needsRefresh, memory != nil else { throw CommerceFailure(409, "Refresh memory before making changes") }
    if case .preference(let input) = action, !input.valid(memory) { throw CommerceFailure(422, "Complete a valid preference") }
    try await work { revision in needsRefresh = true; exported = nil; changed = false; onChange?(); try await client.changeMemory(action); try check(revision); changed = true; switch action { case .preference, .delete: draft = MemoryPreferenceInput(); default: break } }
    try await refresh(conversation: conversation, signedIn: signedIn)
  }
  public func resumeGoal(_ id: String, accept: ([HistoryTurn]) throws -> Void) async throws { try await work { revision in
    let items = try await client.savedGoals(); try check(revision); goals = items
    guard items.contains(where: { $0.id == id && memoryGoalActive($0) }) else { throw CommerceFailure(409, "This saved goal is no longer active") }
    let turns = try await client.assistantHistory(id).filter { $0.conversation_id == id }.sorted { $0.created_at < $1.created_at }; try check(revision); try accept(turns)
  } }
  public func export() async throws { try await work { revision in let value = try await client.exportMemory(); try check(revision); let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]; exported = String(decoding: try encoder.encode(value), as: UTF8.self) } }
}
