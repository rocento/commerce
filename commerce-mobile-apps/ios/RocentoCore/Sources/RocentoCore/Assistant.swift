import Foundation

/// The assistant contract is shared with /v1/assistant/chat. No model/provider credentials live here.
public struct AssistantInput: Encodable, Sendable {
  public let request_id: String
  public let conversation_id: String
  public let message: String
  public let product_id: String?
  public let cart_context: Bool?
  public let clarification: AssistantClarification?
  public let personalize: Bool
  enum CodingKeys: String, CodingKey { case request_id, conversation_id, message, product_id, cart_context, clarification }
  public init(message: String, conversationID: String, requestID: String = UUID().uuidString,
    productID: String? = nil, cartContext: Bool = false, clarification: AssistantClarification? = nil, personalize: Bool = true) {
    request_id = requestID; conversation_id = conversationID; self.message = message
    product_id = productID; cart_context = cartContext ? true : nil; self.clarification = clarification
    self.personalize = personalize
  }
}
public struct AssistantClarification: Codable, Sendable {
  public let original_message: String
  public let question: String
  public let revision: String?
  public let kind: String?
  public let choices: [String]?
  public let optional: Bool?
}
public struct AssistantProduct: Decodable, Sendable, Identifiable {
  public let id: String
  public let name: String
  public let image_id: String?
  public let price: String
  public let original_price: String?
  public let currency: String
  public let in_stock: Bool?
  public let route: String
  public let attributes: [Attribute]
  public let reasons: [String]
  public let unmet: [String]
  public struct Attribute: Decodable, Sendable { public let name: String; public let value: String }
}
/// Bounded auxiliary payloads remain data. URLs/text never become executable navigation commands.
public enum AssistantJSON: Codable, Sendable {
  case object([String: AssistantJSON]), array([AssistantJSON]), string(String), number(Double), bool(Bool), null
  public init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() { self = .null }
    else if let v = try? c.decode(Bool.self) { self = .bool(v) }
    else if let v = try? c.decode(String.self) { self = .string(v) }
    else if let v = try? c.decode(Double.self) { self = .number(v) }
    else if let v = try? c.decode([AssistantJSON].self) { self = .array(v) }
    else { self = .object(try c.decode([String: AssistantJSON].self)) }
  }
  public subscript(_ key: String) -> AssistantJSON { if case .object(let v) = self { return v[key] ?? .null }; return .null }
  public var string: String? { if case .string(let v) = self { return v }; return nil }
  public var array: [AssistantJSON] { if case .array(let v) = self { return v }; return [] }
  public var bool: Bool { if case .bool(let v) = self { return v }; return false }
  public var integer: Int { if case .number(let v) = self, v.isFinite, abs(v) < 1e9 { return Int(v) }; return 0 }
  public func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .object(let v): try c.encode(v)
    case .array(let v): try c.encode(v)
    case .string(let v): try c.encode(v)
    case .number(let v): try c.encode(v)
    case .bool(let v): try c.encode(v)
    case .null: try c.encodeNil()
    }
  }
}
public struct AssistantBlock: Decodable, Sendable {
  public let kind: String
  public let text: String?
  public let title: String?
  public let products: [AssistantProduct]?
  public let sources: [Source]?
  public struct Source: Decodable, Sendable { public let kind: String; public let product_id: String; public let route: String }
  public let rows: [ComparisonRow]?
  public let action: AssistantJSON?
  public let cart: AssistantJSON?
  public let proposal_id: String?
  public let product_prompt: AssistantJSON?
  public let cart_removal: AssistantJSON?
  public let cart_removal_choice: AssistantJSON?
  public let compound_choice: AssistantJSON?
  public struct ComparisonRow: Decodable, Sendable { public let label: String; public let values: [String] }
  func validate() throws {
    let known = ["text", "product_card", "product_list", "comparison_table", "recommendation_group", "action", "cart_summary", "basket_proposal", "saved_addresses", "wishlist_manage", "wishlist_transfer", "product_prompt", "cart_removal", "cart_removal_choice", "compound_choice"]
    guard known.contains(kind) else { throw AssistantStreamError.invalid }
    if let products {
      guard (1...8).contains(products.count), Set(products.map(\.id)).count == products.count else { throw AssistantStreamError.invalid }
      guard let sources, sources.count == products.count else { throw AssistantStreamError.invalid }
      for (index, p) in products.enumerated() {
        guard sources[index].kind == "catalog", sources[index].product_id == p.id, sources[index].route == p.route else { throw AssistantStreamError.invalid }
        guard UUID(uuidString: p.id) != nil, p.route == "/products/" + p.id,
          !p.name.isEmpty, p.name.count <= 1000, p.reasons.count <= 20, p.unmet.count <= 20,
          p.attributes.count <= 20, p.image_id == nil || UUID(uuidString: p.image_id!) != nil
        else { throw AssistantStreamError.invalid }
      }
    }
    if ["product_card", "product_list", "comparison_table", "recommendation_group"].contains(kind) && products == nil { throw AssistantStreamError.invalid }
    if kind == "product_card" && products?.count != 1 { throw AssistantStreamError.invalid }
    if kind == "comparison_table" {
      guard let products, products.count >= 2, let rows, (1...24).contains(rows.count), rows.allSatisfy({ $0.values.count == products.count }) else { throw AssistantStreamError.invalid }
    }
    if kind == "basket_proposal" && UUID(uuidString: proposal_id ?? "") == nil { throw AssistantStreamError.invalid }
    if kind == "action" && action?["route"].string != "/search" { throw AssistantStreamError.invalid }
    if kind == "cart_summary" && cart == nil { throw AssistantStreamError.invalid }
  }
}
public struct AssistantEvent: Decodable, Sendable {
  public let version: String
  public let request_id: String
  public let sequence: Int
  public let type: String
  public let text: String?
  public let code: String?
  public let stage: String?
  public let response_source: String?
  public let blocks: [AssistantBlock]?
  public let clarification: AssistantClarification?
  public let saved: Bool?
  public let failure: AssistantJSON?
  public let order: AssistantJSON?
  public let ticket: AssistantJSON?
}
public enum AssistantStreamError: Error, LocalizedError {
  case invalid, interrupted
  public var errorDescription: String? {
    switch self {
    case .invalid: return "The assistant returned an invalid response. Check your cart before sending again."
    case .interrupted: return "The response was interrupted. Check your cart before sending again."
    }
  }
}
/// Incremental UTF-8/SSE framing, including CRLF, comments and arbitrary network chunk boundaries.
public struct AssistantStreamDecoder: Sendable {
  private var line = Data()
  private var dataLines: [String] = []
  private var total = 0
  private var sequence = 0
  private var rich = false
  public private(set) var done = false
  private let requestID: String
  public init(requestID: String) { self.requestID = requestID }
  public mutating func feed(_ data: Data) throws -> [AssistantEvent] {
    total += data.count
    guard total <= 65_536 else { throw AssistantStreamError.invalid }
    var events: [AssistantEvent] = []
    for byte in data {
      if done { break }
      if byte != 10 { line.append(byte); continue }
      if line.last == 13 { line.removeLast() }
      guard let text = String(data: line, encoding: .utf8) else { throw AssistantStreamError.invalid }
      line.removeAll(keepingCapacity: true)
      if text.isEmpty {
        if dataLines.isEmpty { continue }
        let payload = dataLines.joined(separator: "\n"); dataLines = []
        let event = try JSONDecoder().decode(AssistantEvent.self, from: Data(payload.utf8))
        guard event.version == "1", event.request_id.lowercased() == requestID.lowercased(), event.sequence == sequence,
          ["progress", "message.delta", "content.blocks", "card.order", "ticket.created", "error", "done"].contains(event.type)
        else { throw AssistantStreamError.invalid }
        if ["message.delta", "error"].contains(event.type) && (event.text?.isEmpty != false || event.text!.count > 8000) { throw AssistantStreamError.invalid }
        if event.code == "open_checkout" {
          guard event.type == "message.delta", ["R", "L"].contains(event.response_source), event.blocks == nil, event.order == nil, event.ticket == nil, event.failure == nil, event.clarification == nil, event.stage == nil, event.saved == nil else { throw AssistantStreamError.invalid }
        }
        if event.type == "progress" && !["preparing", "catalog", "order", "support", "responding"].contains(event.stage) { throw AssistantStreamError.invalid }
        if let clarification = event.clarification {
          guard event.type == "message.delta", clarification.original_message.count <= 4000, clarification.question.count <= 1000,
            (clarification.choices?.count ?? 0) <= 8,
            clarification.kind != "shopping" || UUID(uuidString: clarification.revision ?? "") != nil else { throw AssistantStreamError.invalid }
        }
        if event.type == "content.blocks" {
          guard !rich, let blocks = event.blocks, (1...8).contains(blocks.count), payload.utf8.count <= 24_576,
            event.text == nil, event.code == nil else { throw AssistantStreamError.invalid }
          try blocks.forEach { try $0.validate() }; rich = true
        } else if event.blocks != nil { throw AssistantStreamError.invalid }
        if event.type == "card.order" && event.order == nil { throw AssistantStreamError.invalid }
        if event.type == "ticket.created" && event.ticket == nil { throw AssistantStreamError.invalid }
        if let failure = event.failure, failure["request_reference"].string?.lowercased() != requestID.lowercased() { throw AssistantStreamError.invalid }
        if event.saved != nil && event.type != "done" { throw AssistantStreamError.invalid }
        sequence += 1; done = event.type == "done"; events.append(event)
      } else if text.hasPrefix("data:") { dataLines.append(String(text.dropFirst(5)).replacingOccurrences(of: "^ ", with: "", options: .regularExpression)) }
    }
    return events
  }
  public func finish() throws { if !done { throw AssistantStreamError.interrupted } }
}
private actor AssistantDecoderBox {
  var parser: AssistantStreamDecoder
  init(_ requestID: String) { parser = AssistantStreamDecoder(requestID: requestID) }
  func feed(_ data: Data) throws -> [AssistantEvent] { try parser.feed(data) }
  func finish() throws { try parser.finish() }
}
extension CommerceClient {
  public func streamAssistant(_ input: AssistantInput, onEvent: @Sendable (AssistantEvent) async throws -> Void) async throws {
    guard !input.message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, input.message.unicodeScalars.count <= 4000,
      UUID(uuidString: input.request_id) != nil, UUID(uuidString: input.conversation_id) != nil,
      input.product_id == nil || UUID(uuidString: input.product_id!) != nil,
      !(input.product_id != nil && input.cart_context == true) else { throw AssistantStreamError.invalid }
    let revision = epoch
    // Guests can discover products. A saved customer session must be restored, never silently downgraded.
    if token == nil, try credentials.readChecked() != nil { _ = try await restore() }
    // A rejected request retries the exact serialized attempt, including byte order.
    let body = try JSONEncoder().encode(input)
    for attempt in 0...1 {
      let sentToken = token
      var request = URLRequest(url: identity.commerceBaseURL.appendingPathComponent("v1/assistant/chat"))
      request.httpMethod = "POST"; request.httpBody = body
      request.timeoutInterval = 35
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
      request.setValue("1", forHTTPHeaderField: "X-Commerce-Request")
      request.setValue("1", forHTTPHeaderField: "X-Commerce-Assistant-Errors")
      request.setValue(input.request_id, forHTTPHeaderField: "X-Commerce-Request-Reference")
      request.setValue(locale, forHTTPHeaderField: "X-Storefront-Locale")
      request.setValue("1", forHTTPHeaderField: "X-Delivery-Context")
      if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
      if token == nil, let memoryGuest { request.setValue("assistant_guest=\(memoryGuest)", forHTTPHeaderField: "Cookie") }
      if !input.personalize { request.setValue("0", forHTTPHeaderField: "X-Commerce-Personalize") }
      if let pin {
        request.setValue(String(pin.latitude), forHTTPHeaderField: "X-Delivery-Latitude")
        request.setValue(String(pin.longitude), forHTTPHeaderField: "X-Delivery-Longitude")
      }
      let decoder = AssistantDecoderBox(input.request_id)
      do {
        try await transport.stream(request, maxBytes: 65_536, onResponse: { response in
          guard response.status == 200 else { throw CommerceFailure(response.status, "Assistant request failed") }
          guard response.header("content-type")?.lowercased().hasPrefix("text/event-stream") == true else { throw AssistantStreamError.invalid }
        }, onChunk: { data in
          try Task.checkCancellation()
          try await self.checkAssistantSession(revision)
          let events = try await decoder.feed(data)
          for event in events { try Task.checkCancellation(); try await self.checkAssistantSession(revision); try await onEvent(event) }
          return events.last?.type == "done"
        })
        try checkAssistantSession(revision)
        try await decoder.finish()
        return
      } catch let e as CommerceFailure where e.status == 401 && attempt == 0 && sentToken != nil {
        // Only a rejected HTTP request may be retried. Never replay a partially received turn.
        try checkAssistantSession(revision)
        if token == sentToken { _ = try await restore() }
      }
    }
  }
  private func checkAssistantSession(_ revision: Int) throws {
    guard epoch == revision else { throw CommerceFailure(401, "Session changed") }
  }
}

/// Reducer shared by UI and tests: a checkout command is actionable only after a successful done event.
public struct AssistantReply: Sendable {
  public var text = ""
  public var blocks: [AssistantBlock] = []
  public var clarification: AssistantClarification?
  public var completed = false
  public var failed = false
  public var needsLogin = false
  public var needsAddress = false
  public var order: AssistantJSON?
  public var ticket: AssistantJSON?
  private var checkoutRequested = false
  public var opensCheckout: Bool { completed && !failed && checkoutRequested }
  public init() {}
  public func productForFollowup(_ message: String) -> String? {
    let ids = Set(blocks.flatMap { $0.products ?? [] }.map(\.id))
    guard ids.count == 1, order == nil, !blocks.contains(where: { ["cart_summary", "cart_removal"].contains($0.kind) }) else { return nil }
    let text = message.precomposedStringWithCompatibilityMapping.lowercased().trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters))
    let pattern = #"^(?:(?:please )?(?:price|availability|stock|details|how much is it|is it available|is it in stock|tell me about it|add(?: \d+)?(?: of)? (?:it|this|that)(?: to (?:my |the )?cart)?|remove (?:it|this|that)(?: from (?:my |the )?cart)?)|(?:أضفه|اضفه|أضف هذا|اضف هذا)(?: إلى السلة| للسلة)?|كم سعره|هل هو متوفر|احذفه من السلة)$"#
    return text.range(of: pattern, options: .regularExpression) == nil ? nil : ids.first
  }
  public mutating func consume(_ event: AssistantEvent) {
    switch event.type {
    case "message.delta":
      text = String((text + (event.text ?? "")).prefix(8000))
      clarification = event.clarification ?? clarification
      needsLogin = needsLogin || event.code == "login_required"
      needsAddress = needsAddress || ["area_unavailable", "open_address_form"].contains(event.code)
      checkoutRequested = checkoutRequested || event.code == "open_checkout"
    case "content.blocks": blocks = event.blocks ?? []
    case "card.order": order = event.order
    case "ticket.created": ticket = event.ticket
    case "error":
      failed = true
      needsLogin = needsLogin || event.code == "login_required" || event.failure?["recovery"].string == "sign_in"
      text += (text.isEmpty ? "" : "\n") + (event.text ?? "")
    case "done": completed = true
    default: break
    }
  }
}
