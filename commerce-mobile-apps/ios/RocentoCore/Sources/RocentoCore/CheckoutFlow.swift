import Foundation

public struct CheckoutSelection: Sendable {
  public let method: String
  public let location: String?
  public let source: String?
  public let date: String
  public let asap: Bool
  public init(method: String, location: String?, source: String?, date: String, asap: Bool) {
    self.method = method; self.location = location; self.source = source; self.date = date; self.asap = asap
  }
}

/// Checkout presentation state. Durable order attempts remain owned by CommerceClient.
@MainActor public final class CheckoutFlow {
  public enum Phase: Sendable { case editing, loadingOptions, quoting, ready, submitting, uncertain, completed }
  public private(set) var phase: Phase = .editing
  public private(set) var quote: CommerceQuote?
  public private(set) var options: FulfillmentOptions?
  public private(set) var windows: [String: FulfillmentSlot] = [:]
  public private(set) var giftMessage = ""
  public var giftMessageValid: Bool { giftMessage.utf8.count <= 500 }
  public var onChange: (() -> Void)?
  private var generation = 0
  public init() {}
  public var busy: Bool { phase == .loadingOptions || phase == .quoting || phase == .submitting }
  public var locked: Bool { phase == .submitting || phase == .uncertain }

  public func findOptions(client: any CheckoutServing, selection: CheckoutSelection) async throws {
    try await loadOptions {
      try await client.deliveryOptions(method: selection.method, location: selection.location,
        source: selection.source, date: selection.date, asap: selection.asap)
    }
  }
  public func review(client: any CheckoutServing, selection: CheckoutSelection) async throws {
    guard giftMessageValid else { throw CommerceFailure(422, "Please shorten your gift message") }
    let message = giftMessage
    let slots = Array(windows.values)
    let revision = generation
    try await review {
      try await client.reserveDelivery(method: selection.method, location: selection.location,
        source: selection.source, date: selection.date, asap: selection.asap, windows: slots, key: UUID().uuidString)
      guard revision == generation else { throw CancellationError() }
      return try await client.quote(location: selection.location, giftMessage: message)
    }
  }
  public func place(client: any CheckoutServing) async throws -> CustomerOrderDetail {
    try await place({ try await client.place($0) }, pending: { try await client.pendingCheckout()?.quote })
  }

  public func reset() {
    generation += 1
    phase = .editing; quote = nil; options = nil; windows = [:]; giftMessage = ""; onChange?()
  }
  public func invalidate() {
    guard !locked else { return }
    generation += 1; phase = .editing; quote = nil; options = nil; windows = [:]; onChange?()
  }
  public func setGiftMessage(_ value: String) {
    guard !busy && !locked else { return }
    giftMessage = value; quote = nil; phase = .editing; onChange?()
  }
  public func restore(_ pending: CommerceQuote?) {
    reset()
    if let pending { quote = pending; giftMessage = pending.snapshot.gift_message ?? ""; phase = .uncertain; onChange?() }
  }
  public func select(_ slots: [String: FulfillmentSlot]) {
    guard !busy && !locked else { return }
    windows = slots; quote = nil; phase = .editing; onChange?()
  }
  public func edit() {
    guard !busy && !locked else { return }
    quote = nil; phase = .editing; onChange?()
  }
  public func loadOptions(_ operation: () async throws -> FulfillmentOptions) async throws {
    guard !busy && !locked else { throw CommerceFailure(409, "Checkout is already in progress") }
    invalidate(); let revision = generation
    phase = .loadingOptions; onChange?()
    do {
      let result = try await operation()
      guard revision == generation else { throw CancellationError() }
      options = result; phase = .editing; onChange?()
    } catch {
      if revision == generation { phase = .editing; onChange?() }
      throw error
    }
  }
  public func review(_ operation: () async throws -> CommerceQuote) async throws {
    guard !busy && !locked else { throw CommerceFailure(409, "Checkout is already in progress") }
    guard giftMessageValid else { throw CommerceFailure(422, "Please shorten your gift message") }
    let revision = generation
    quote = nil; phase = .quoting; onChange?()
    do {
      let result = try await operation()
      guard revision == generation else { throw CancellationError() }
      quote = result; phase = .ready; onChange?()
    } catch {
      if revision == generation { phase = .editing; onChange?() }
      throw error
    }
  }
  public func place(
    _ operation: (CommerceQuote) async throws -> CustomerOrderDetail,
    pending: () async throws -> CommerceQuote?
  ) async throws -> CustomerOrderDetail {
    guard phase == .ready || phase == .uncertain, let reviewed = quote else {
      throw CommerceFailure(409, "Review your checkout before confirming")
    }
    let revision = generation
    phase = .submitting; onChange?()
    do {
      let result = try await operation(reviewed)
      guard revision == generation else { throw CancellationError() }
      quote = nil; options = nil; windows = [:]; giftMessage = ""; phase = .completed; onChange?()
      return result
    } catch {
      if revision == generation {
        // Storage failure cannot establish that the order was not submitted.
        phase = .uncertain; onChange?()
        do {
          let saved = try await pending()
          if revision == generation {
            quote = saved; phase = saved == nil ? .editing : .uncertain
            if saved == nil { options = nil; windows = [:] }
            onChange?()
          }
        } catch {
          if error is CancellationError || (error as? URLError)?.code == .cancelled { throw error }
          // Keep the reviewed quote locked for explicit recovery.
        }
      }
      throw error
    }
  }
}
