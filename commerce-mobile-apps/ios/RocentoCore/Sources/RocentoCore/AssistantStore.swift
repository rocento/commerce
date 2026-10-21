import Foundation

public protocol AssistantServing: Sendable {
  func setLocale(_ value: String) async
  func streamAssistant(_ input: AssistantInput, onEvent: @Sendable (AssistantEvent) async throws -> Void) async throws
}
extension CommerceClient: AssistantServing {}

public struct AssistantTurn: Identifiable {
  public let id: String
  public let question: String
  public var reply = AssistantReply()
  public var interrupted = false
}
@MainActor public final class AssistantStore {
  public var onChange: (() -> Void)?
  let client: any AssistantServing
  public private(set) var turns: [AssistantTurn] = [] { didSet { onChange?() } }
  public var draft = "" { didSet { onChange?() } }
  public private(set) var busy = false { didSet { onChange?() } }
  public private(set) var stage = "preparing" { didSet { onChange?() } }
  public private(set) var signInRequired = false { didSet { onChange?() } }
  public private(set) var conversationID = UUID().uuidString
  public var personalize = true { didSet { onChange?() } }
  public func restoreConversation(_ id: String, history: [HistoryTurn]) throws {
    guard !busy else { throw CommerceFailure(409, "Wait for the current response") }; try HistoryTurn.validate(history)
    generation = UUID(); conversationID = id; draft = ""; signInRequired = false
    turns = history.map { value in var reply = AssistantReply(); reply.text = value.answer; reply.blocks = value.blocks ?? []; reply.completed = true; return AssistantTurn(id: value.request_id, question: value.question, reply: reply) }
  }
  private var generation = UUID()
  private var task: Task<Void, Never>?
  public init(client: any AssistantServing) { self.client = client }
  public func reset() {
    task?.cancel(); generation = UUID(); conversationID = UUID().uuidString
    turns = []; draft = ""; busy = false; stage = "preparing"; signInRequired = false
    personalize = true
  }
  public func stop() { task?.cancel() }
  public func send(_ message: String, locale: String, productID: String? = nil, cartContext: Bool = false,
    settled: @escaping @MainActor () async -> Void, checkout: @escaping @MainActor () -> Void) {
    let message = message.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !busy, !message.isEmpty, message.unicodeScalars.count <= 4000 else { return }
    let clarification = turns.last?.reply.clarification
    let input = AssistantInput(message: message, conversationID: conversationID, productID: productID ?? (cartContext ? nil : turns.last?.reply.productForFollowup(message)),
      cartContext: cartContext, clarification: clarification, personalize: personalize)
    let current = generation
    turns.append(AssistantTurn(id: input.request_id, question: message))
    if turns.count > 50 { turns.removeFirst(turns.count - 50) }
    draft = ""; busy = true; stage = "preparing"; signInRequired = false
    task = Task {
      do {
        await client.setLocale(locale)
        try await client.streamAssistant(input) { event in
          await MainActor.run {
            guard self.generation == current, !Task.isCancelled,
              let index = self.turns.firstIndex(where: { $0.id == input.request_id }) else { return }
            self.turns[index].reply.consume(event)
            if event.type == "progress" { self.stage = event.stage ?? "preparing" }
            if event.type == "message.delta" { self.stage = "responding" }
          }
        }
        try Task.checkCancellation()
      } catch {
        guard generation == current else { return }
        if let index = turns.firstIndex(where: { $0.id == input.request_id }) {
          turns[index].interrupted = true; turns[index].reply.failed = true
        }
        signInRequired = (error as? CommerceFailure)?.status == 401
      }
      guard generation == current else { return }
      let open = turns.last?.reply.opensCheckout == true && !Task.isCancelled
      // Refresh even after interruption: a cart action may have committed before the connection ended.
      await Task { @MainActor in await settled() }.value
      guard generation == current else { return }
      busy = false
      if open, !Task.isCancelled { checkout() }
    }
  }
}
