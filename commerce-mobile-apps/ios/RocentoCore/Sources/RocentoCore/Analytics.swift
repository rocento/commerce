import Foundation

/// Fixed anonymous funnel events only: no customer, product, order, search or location data.
public enum CommerceEvent: Sendable {
  case home, catalog, product, bag, added, checkout, ordered
  var fields: (String, String) {
    switch self {
    case .home: return ("page_view", "/")
    case .catalog: return ("page_view", "/categories/native")
    case .product: return ("page_view", "/products/native")
    case .bag: return ("page_view", "/cart")
    case .added: return ("cart_added", "/cart")
    case .checkout: return ("checkout_started", "/checkout")
    case .ordered: return ("order_placed", "/checkout/complete")
    }
  }
}
public actor CommerceAnalytics {
  public nonisolated let initiallyEnabled: Bool
  private let storage: any CredentialStorage
  private let identity: AppIdentity
  private let transport: any HTTPTransport
  private var enabled: Bool
  private var session = UUID().uuidString
  private var visitor: String?
  private var busy = false
  public init(
    identity: AppIdentity, storage: any CredentialStorage,
    transport: any HTTPTransport = URLSessionTransport()
  ) {
    self.identity = identity
    self.storage = storage
    self.transport = transport
    initiallyEnabled = storage.read() == "true"
    enabled = initiallyEnabled
  }
  public func consent(_ value: Bool) throws {
    try storage.save(value ? "true" : nil)
    enabled = value
    if !value {
      session = UUID().uuidString
      visitor = nil
    }
  }
  public func record(_ event: CommerceEvent) async {
    guard enabled, !busy else { return }
    busy = true
    defer { busy = false }
    let currentSession = session
    let fields = event.fields
    do {
      var request = URLRequest(
        url: identity.commerceBaseURL.appendingPathComponent("v1/analytics/events"))
      request.httpMethod = "POST"
      request.setValue("1", forHTTPHeaderField: "X-Commerce-Request")
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      if let visitor {
        request.setValue("analytics_visitor=\(visitor)", forHTTPHeaderField: "Cookie")
      }
      request.httpBody = try JSONSerialization.data(withJSONObject: [
        "id": UUID().uuidString, "session_id": currentSession, "event_type": fields.0,
        "path": fields.1, "source": "direct",
      ])
      let response = try await transport.get(request, maxBytes: 16_384)
      guard enabled, session == currentSession else { return }
      let header = response.header("set-cookie") ?? ""
      let regex = try NSRegularExpression(
        pattern: "(?:^|,\\s*)analytics_visitor=([A-Za-z0-9_-]{16,512})(?:;|$)")
      if let match = regex.firstMatch(in: header, range: NSRange(header.startIndex..., in: header)),
        let range = Range(match.range(at: 1), in: header)
      {
        visitor = String(header[range])
      }
    } catch { /* Optional telemetry never blocks commerce or retries without consent. */  }
  }
}
