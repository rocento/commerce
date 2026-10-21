import Foundation

public struct CommerceFailure: Error, LocalizedError, Sendable {
  public let status: Int
  public let message: String
  public var errorDescription: String? { message }
  public init(_ status: Int, _ message: String) {
    self.status = status
    self.message = message
  }
}
public struct CustomerAccount: Codable, Sendable, Identifiable {
  public let id: String
  public let primary_identifier: String
  public let email: String?
  public let mobile_number: String?
  public let verified: Bool
  public var identifier: String {
    switch primary_identifier {
    case "email": return email ?? ""
    case "mobile": return mobile_number ?? ""
    default: return ""
    }
  }
}
public struct CustomerAuth: Decodable, Sendable {
  public let customer: CustomerAccount
  public let access_token: String
}
public struct CommerceCartItem: Codable, Sendable, Identifiable {
  public let product_id: String
  public let name: String
  public let quantity: Int
  public let reserved_quantity: Int
  public let price: String
  public let line_total: String
  public let unit: String?
  public let available: Int?
  public var id: String { product_id }
}
public struct CommerceCart: Codable, Sendable {
  public let id: String
  public let items: [CommerceCartItem]
  public let subtotal: String
  public let currency: String
  public let fully_reserved: Bool
  public let discount_amount: String?
  public let coupon_code: String?
  public let coupon_error: String?
  /// Cart subtotal excludes delivery and tax; only the checkout quote is a final total.
  public var itemsTotal: String {
    guard let subtotal = Decimal(string: subtotal), !subtotal.isNaN,
      let discount = Decimal(string: discount_amount ?? "0"), !discount.isNaN else { return self.subtotal }
    return NSDecimalNumber(decimal: max(0, subtotal - discount)).stringValue
  }
}
public struct DeliveryPin: Codable, Sendable {
  public let latitude: Double
  public let longitude: Double
  public init(latitude: Double, longitude: Double) throws {
    guard latitude.isFinite, longitude.isFinite, (-90...90).contains(latitude),
      (-180...180).contains(longitude)
    else { throw CommerceFailure(422, "Choose a valid delivery pin") }
    self.latitude = latitude
    self.longitude = longitude
  }
}
public struct DeliveryCoverage: Decodable, Sendable {
  public let configured: Bool
  public let deliverable: Bool
}
public struct CustomerLocation: Codable, Identifiable, Sendable {
  public let id: String
  public let label: String
  public let latitude: Double
  public let longitude: Double
  public let formatted_address: String
  public let building: String
  public let floor: String
  public let apartment: String
  public let delivery_instructions: String
  public let is_default: Bool
  public let updated_at: String?
  public let location_method: String?
  public let geography: AssistantJSON?
}
public struct CommerceQuote: Codable, Sendable, Identifiable {
  public let id: String
  public let expires_at: String
  public let snapshot: Snapshot
  public struct Snapshot: Codable, Sendable {
    public let subtotal: String
    public let discount_amount: String
    public let delivery_fee: String
    public let tax_amount: String
    public let total: String
    public let currency: String
    public let payment_method: String
    public let gift_message: String?
    // Optional for attempts saved by older app versions. Never substitute live form state.
    public let items: [CustomerOrderItem]?
    public let location: Destination?
    public let fulfillment_plan: Fulfillment?
    public let scheduled_delivery: Window?
    public var method: String? { fulfillment_plan?.method ?? location?.location_method }
  }
  public struct Destination: Codable, Sendable {
    public let formatted_address: String
    public let custom_label: String?
    public let building: String?
    public let floor: String?
    public let apartment: String?
    public let delivery_instructions: String?
    public let location_method: String?
  }
  public struct Fulfillment: Codable, Sendable {
    public let method: String
    public let groups: [Group]
    public struct Group: Codable, Sendable, Identifiable {
      public let source_id: String
      public let source_name: String
      public let starts_at: String?
      public let ends_at: String?
      public let timezone: String?
      public let schedule_id: String?
      public var id: String { source_id }
    }
  }
  public struct Window: Codable, Sendable {
    public let starts_at: String?
    public let ends_at: String?
    public let timezone: String?
  }
}
public struct CustomerOrder: Codable, Identifiable, Sendable {
  public let id: String
  public let number: Int64
  public let status: String
  public let total: String
  public let currency: String
  public let created_at: String
  public var gift_message: String? = nil
  public var subtotal: String? = nil
  public var discount_amount: String? = nil
  public var delivery_fee: String? = nil
  public var tax_amount: String? = nil
}
public struct CustomerOrderItem: Codable, Identifiable, Sendable {
  public let product_id: String
  public let name: String
  public let quantity: Int
  public let price: String
  public let line_total: String
  public let unit: String?
  public let discount_amount: String?
  public var id: String { product_id }
}
public struct CustomerOrderDetail: Decodable, Sendable {
  public let order: CustomerOrder
  public let history: [OrderHistory]
  public var items: [CustomerOrderItem]? = nil
  public struct OrderHistory: Decodable, Sendable, Identifiable {
    public let id: String
    public let status: String
    public let created_at: String
  }
}
public struct FulfillmentSlot: Codable, Sendable, Identifiable {
  public let schedule_id: String
  public let source_id: String
  public let starts_at: String
  public let ends_at: String
  public let availability: String
  public var id: String { "\(source_id)|\(schedule_id)|\(starts_at)" }
}
public struct FulfillmentOptions: Decodable, Sendable {
  public let groups: [Group]
  public struct Group: Decodable, Sendable, Identifiable {
    public let source_id: String
    public let source_name: String
    public let slots: [FulfillmentSlot]
    public var id: String { source_id }
  }
}
public struct FulfillmentAvailability: Decodable, Sendable {
  public let methods: [Method]
  public struct Method: Decodable, Sendable, Identifiable {
    public let type: String
    public let scheduling: Bool
    public let asap: Bool?
    public let locations: [Pickup]?
    public var id: String { type }
  }
  public struct Pickup: Decodable, Sendable, Identifiable {
    public let id: String
    public let name: String
  }
}
public struct CheckoutAttempt: Codable, Sendable {
  public let customerID: String
  public let quote: CommerceQuote
  public let key: String
}
public protocol CredentialStorage: Sendable {
  func read() -> String?
  func save(_ value: String?) throws
  func readChecked() throws -> String?
  func savePreserving(_ value: String) throws
}
public extension CredentialStorage {
  func readChecked() throws -> String? { read() }
  func savePreserving(_ value: String) throws { try save(value) }
}
extension SecureSession: CredentialStorage {}

/// One immutable installation per client. Customer bearers never reach config or image origins.
public actor CommerceClient: CatalogServing {
  public nonisolated let identity: AppIdentity
  let transport: any HTTPTransport
  let credentials: any CredentialStorage
  let attempts: any CredentialStorage
  let reorders: (any CredentialStorage)?
  let deletionReceipts: (any CredentialStorage)?
  private var supportGuest: String?
  var memoryGuest: String?
  var token: String?
  var customer: CustomerAccount?
  var epoch = 0
  var refreshTask: Task<(CustomerAuth, String), Error>?
  var refreshID = UUID()
  var locale = "en"
  var pin: DeliveryPin?
  public init(
    identity: AppIdentity, credentials: any CredentialStorage, attempts: any CredentialStorage,
    transport: any HTTPTransport = URLSessionTransport(), reorders: (any CredentialStorage)? = nil, deletionReceipts: (any CredentialStorage)? = nil
  ) {
    self.identity = identity
    self.credentials = credentials
    self.attempts = attempts
    self.transport = transport
    self.reorders = reorders
    self.deletionReceipts = deletionReceipts
  }
  public func setLocale(_ value: String) { locale = value == "ar" ? "ar" : "en" }
  public func setDelivery(_ value: DeliveryPin?) { pin = value }
  static func identifier(_ value: String) throws -> String {
    guard UUID(uuidString: value) != nil else { throw CommerceFailure(422, "Invalid resource") }
    return value
  }
  static func refreshCookie(_ response: HTTPResult) throws -> String {
    let header = response.header("set-cookie") ?? ""
    let regex = try NSRegularExpression(
      pattern: "(?:^|,\\s*)customer_refresh=([A-Za-z0-9_-]{32,512})(?:;|$)")
    guard
      let match = regex.firstMatch(in: header, range: NSRange(header.startIndex..., in: header)),
      let range = Range(match.range(at: 1), in: header)
    else { throw CommerceFailure(502, "Unable to establish a secure session") }
    return String(header[range])
  }
  private func raw(
    _ path: String, method: String = "GET", body: Data? = nil, bearer: String? = nil,
    refresh: String? = nil, delivery: DeliveryPin? = nil, supportGuest: String? = nil, memoryGuest: String? = nil
  ) async throws -> HTTPResult {
    guard path.hasPrefix("v1/"), !path.contains(".."), !path.contains("://"), !path.contains("#")
    else { throw CommerceFailure(422, "Invalid request") }
    let url = URL(
      string: identity.commerceBaseURL.absoluteString.trimmingCharacters(
        in: CharacterSet(charactersIn: "/")) + "/" + path)!
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.httpBody = body
    request.setValue("1", forHTTPHeaderField: "X-Commerce-Request")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue(locale, forHTTPHeaderField: "X-Storefront-Locale")
    request.setValue("1", forHTTPHeaderField: "X-Delivery-Context")
    if let pin = delivery ?? pin {
      request.setValue(String(pin.latitude), forHTTPHeaderField: "X-Delivery-Latitude")
      request.setValue(String(pin.longitude), forHTTPHeaderField: "X-Delivery-Longitude")
    }
    if let bearer { request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
    if let refresh { request.setValue("customer_refresh=\(refresh)", forHTTPHeaderField: "Cookie") }
    if let supportGuest { request.setValue("support_guest=\(supportGuest)", forHTTPHeaderField: "Cookie") }
    if let memoryGuest { request.setValue("assistant_guest=\(memoryGuest)", forHTTPHeaderField: "Cookie") }
    return try await transport.get(request, maxBytes: 2_000_000)
  }
  private func checked<T: Decodable>(_ r: HTTPResult, as: T.Type = T.self) throws -> T {
    guard (200..<300).contains(r.status) else {
      let message =
        (try? JSONSerialization.jsonObject(with: r.body) as? [String: Any])?["error"] as? String
      throw CommerceFailure(
        r.status, String((message ?? "Request failed. Please retry.").prefix(400)))
    }
    return try JSONDecoder().decode(T.self, from: r.body)
  }
  private func data(_ value: [String: Any]) throws -> Data {
    try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
  }
  public func login(identifier: String, password: String) async throws -> CustomerAccount {
    memoryGuest = nil
    epoch += 1
    let revision = epoch
    token = nil
    customer = nil
    pin = nil
    refreshTask?.cancel()
    refreshTask = nil
    try credentials.save(nil)
    let response = try await raw(
      "v1/customer/auth/login", method: "POST",
      body: data(["identifier": identifier, "password": password]))
    let auth: CustomerAuth = try checked(response)
    let refresh = try Self.refreshCookie(response)
    guard revision == epoch else { throw CommerceFailure(401, "Session changed") }
    try credentials.save(refresh)
    token = auth.access_token
    customer = auth.customer
    return auth.customer
  }
  public func restore() async throws -> CustomerAccount {
    let revision = epoch
    if refreshTask == nil {
      guard let refresh = try credentials.readChecked() else { throw CommerceFailure(401, "Please sign in") }
      refreshID = UUID()
      refreshTask = Task {
        let r = try await self.raw("v1/customer/auth/refresh", method: "POST", refresh: refresh)
        if r.status == 204 { throw CommerceFailure(401, "Please sign in") }
        return (try self.checked(r, as: CustomerAuth.self), try Self.refreshCookie(r))
      }
    }
    let pending = refreshTask!
    let pendingID = refreshID
    do {
      let (auth, refresh) = try await pending.value
      guard revision == epoch else { throw CommerceFailure(401, "Session changed") }
      if pendingID == refreshID && refreshTask != nil {
        try credentials.save(refresh)
        token = auth.access_token
        customer = auth.customer
        refreshTask = nil
      }
      return customer ?? auth.customer
    } catch {
      if revision == epoch && pendingID == refreshID && refreshTask != nil {
        refreshTask = nil
        if let failure = error as? CommerceFailure, [401, 403, 204].contains(failure.status) {
          token = nil
          customer = nil
          pin = nil
          try credentials.save(nil)
        }
      }
      throw error
    }
  }
  public func accountRetentionPolicy() async throws -> AccountRetentionPolicy? {
    try await request("v1/customer/deletion-policy")
  }
  public func accountDeletionReceipt() throws -> AccountDeletionReceipt? {
    guard let raw = try deletionReceipts?.readChecked() else { return nil }
    return try JSONDecoder().decode(AccountDeletionReceipt.self, from: Data(raw.utf8))
  }
  public func accountDeletionStatus() async throws -> AccountDeletionStatus? {
    guard let receipt = try accountDeletionReceipt() else { return nil }
    let body = try JSONSerialization.data(withJSONObject: ["request_id": receipt.request_id, "receipt_token": receipt.receipt_token])
    let status: AccountDeletionStatus = try await request("v1/customer/account-deletion/status", method: "POST", body: body, authenticated: false)
    if customer == nil || customer?.id == receipt.customer_id {
      do { try clearDeletedAccount() } catch { throw AccountDeletionCleanupFailure(status: status) }
    }
    return status
  }
  public func deleteAccount(policy: AccountRetentionPolicy, password: String) async throws -> AccountDeletionStatus {
    guard let customer, let deletionReceipts else { throw CommerceFailure(401, "Secure deletion storage is unavailable") }
    var saved = try accountDeletionReceipt()
    if let previous = saved, previous.customer_id != customer.id || previous.policy_id != policy.id {
      let body = try JSONSerialization.data(withJSONObject: ["request_id": previous.request_id, "receipt_token": previous.receipt_token])
      do {
        let existing: AccountDeletionStatus = try await request("v1/customer/account-deletion/status", method: "POST", body: body, authenticated: false)
        guard existing.state == "complete", previous.customer_id != customer.id else { throw CommerceFailure(409, "A deletion request is already in progress") }
        saved = nil
      } catch let error as CommerceFailure where error.status == 404 { saved = nil }
    }
    let receipt = saved ?? AccountDeletionReceipt(request_id: UUID().uuidString,
      receipt_token: UUID().uuidString.replacingOccurrences(of: "-", with: "") + UUID().uuidString.replacingOccurrences(of: "-", with: ""), customer_id: customer.id, policy_id: policy.id)
    guard receipt.policy_id == policy.id else { throw CommerceFailure(409, "Review the saved deletion request before continuing") }
    // Save before dispatch: a lost response must never lose the independent status credential.
    try deletionReceipts.save(String(decoding: JSONEncoder().encode(receipt), as: UTF8.self))
    let body = try JSONSerialization.data(withJSONObject: ["request_id": receipt.request_id, "receipt_token": receipt.receipt_token,
      "policy_id": receipt.policy_id, "password": password, "confirm": true])
    let status: AccountDeletionStatus = try await request("v1/customer/account-deletion", method: "POST", body: body)
    do { try clearDeletedAccount() } catch { throw AccountDeletionCleanupFailure(status: status) }
    return status
  }
  private func clearDeletedAccount() throws {
    epoch += 1; token = nil; customer = nil; pin = nil; memoryGuest = nil; supportGuest = nil
    refreshTask?.cancel(); refreshTask = nil
    try credentials.save(nil); try attempts.save(nil); try reorders?.save(nil)
  }
  public func logout() async throws {
    memoryGuest = nil
    let oldToken = token
    let oldRefresh = try credentials.readChecked()
    epoch += 1
    token = nil
    customer = nil
    pin = nil
    refreshTask?.cancel()
    refreshTask = nil
    try credentials.save(nil)
    _ = try? await raw(
      "v1/customer/auth/logout", method: "POST", bearer: oldToken, refresh: oldRefresh)
  }
  private func request<T: Decodable>(
    _ path: String, method: String = "GET", body: Data? = nil, authenticated: Bool = true
  ) async throws -> T {
    let revision = epoch
    if authenticated && token == nil { _ = try await restore() }
    let sentToken = authenticated ? token : nil
    var response = try await raw(path, method: method, body: body, bearer: sentToken)
    guard revision == epoch else { throw CommerceFailure(401, "Session changed") }
    if authenticated && response.status == 401 {
      if token == sentToken { _ = try await restore() }
      response = try await raw(path, method: method, body: body, bearer: token)
      guard revision == epoch else { throw CommerceFailure(401, "Session changed") }
    }
    return try checked(response)
  }
  private struct Acknowledgement: Decodable {}
  public func authAction(
    _ action: String, identifier: String, password: String? = nil, code: String? = nil
  ) async throws {
    guard
      ["register", "request-verification", "verify", "forgot-password", "reset-password"].contains(
        action)
    else { throw CommerceFailure(422, "Invalid action") }
    var body = ["identifier": identifier]
    if let password { body["password"] = password }
    if let code { body["token"] = code }
    let _: Acknowledgement = try await request(
      "v1/customer/auth/\(action)", method: "POST", body: data(body), authenticated: false)
    if action == "reset-password" { try await logout() }
  }
  public func registerPushDevice(_ id: String, appID: String, token: String, customerID: String) async throws {
    let _: Acknowledgement = try await request("v1/customer/push-devices/\(Self.identifier(id))", method: "PUT",
      body: data(["platform": "ios", "app_id": appID, "token": token, "locale": locale, "customer_id": customerID]))
  }
  public func unregisterPushDevice(_ id: String) async throws {
    let _: Acknowledgement = try await request("v1/customer/push-devices/\(Self.identifier(id))", method: "DELETE")
  }
  public func me() async throws -> CustomerAccount {
    let c: CustomerAccount = try await request("v1/customer/me")
    customer = c
    return c
  }
  public func assistantProducts(_ query: String, locale: String) async throws -> [Product] {
    guard query.count <= 120 else { throw CommerceFailure(422, "Search is too long") }
    setLocale(locale)
    struct Results: Decodable { let hits: [Product] }
    let encoded = query.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
    let result: Results = try await request("v1/search?q=" + encoded, authenticated: false)
    return Array(result.hits.prefix(8))
  }
  public func assistantProposal(_ id: String) async throws -> AssistantJSON {
    try await request("v1/cart/proposals/\(Self.identifier(id))")
  }
  public func reorderTask(_ order: String, again: Bool = false) throws -> ReorderTask {
    guard let customer, let reorders else { throw CommerceFailure(401, "Reorder storage is unavailable") }
    let key = customer.id + ":" + (try Self.identifier(order))
    var saved = try reorders.readChecked().map { try JSONDecoder().decode([String: ReorderTask].self, from: Data($0.utf8)) } ?? [:]
    if !again, let task = saved[key] { _ = try Self.identifier(task.task); return task }
    let task = ReorderTask(task: UUID().uuidString, pending: false); saved[key] = task
    try reorders.savePreserving(String(decoding: JSONEncoder().encode(saved), as: UTF8.self)); return task
  }
  public func saveReorderTask(_ order: String, task: ReorderTask) throws {
    guard let customer, let reorders else { throw CommerceFailure(401, "Reorder storage is unavailable") }
    var saved = try reorders.readChecked().map { try JSONDecoder().decode([String: ReorderTask].self, from: Data($0.utf8)) } ?? [:]
    saved[customer.id + ":" + (try Self.identifier(order))] = task
    try reorders.savePreserving(String(decoding: JSONEncoder().encode(saved), as: UTF8.self))
  }
  public func reorderContext(_ task: String) async throws -> AssistantJSON { try await request("v1/cart/shopping/\(Self.identifier(task))") }
  public func proposeReorder(task: String, order: String, location: String, selections: [AssistantJSON]? = nil) async throws -> AssistantJSON {
    let revision = epoch
    let context = try await reorderContext(task)
    guard revision == epoch else { throw CommerceFailure(401, "Session changed") }
    let goal: [String: Any] = ["purpose": "Reorder", "budget": NSNull(), "currency": NSNull(), "all_inclusive": false, "budget_exclusive": false, "people": NSNull(), "locked_products": [], "excluded_products": [], "locked_brands": [], "allow_substitutions": false, "delivery_date": NSNull(), "assumptions": [], "unresolved": [], "saving_target": NSNull()]
    let items = try JSONSerialization.jsonObject(with: JSONEncoder().encode(selections ?? []))
    return try await request("v1/cart/proposals", method: "POST", body: data(["task_id": Self.identifier(task), "task_revision": context["task_revision"].integer, "source_revision": context["source_revision"].integer, "mode": "buy_again", "auto_select": selections == nil, "order_id": Self.identifier(order), "location_id": Self.identifier(location), "selections": items, "goal": goal]))
  }
  public func applyAssistantProposal(_ id: String) async throws -> CommerceCart {
    let id = try Self.identifier(id)
    let revision = epoch
    let _: Acknowledgement = try await request("v1/cart/trust/confirm", method: "POST",
      body: data(["proposal_id": id, "idempotency_key": id, "grant_id": NSNull()]))
    guard revision == epoch else { throw CommerceFailure(401, "Session changed") }
    return try await request("v1/cart/proposals/\(id)/apply", method: "POST", body: data(["idempotency_key": id]))
  }
  public func wishlist() async throws -> [String] { try await request("v1/customer/wishlist") }
  public func saveProduct(_ id: String, saved: Bool) async throws {
    let _: Acknowledgement = try await request("v1/customer/wishlist/\(try Self.identifier(id))", method: saved ? "PUT" : "DELETE")
  }
  public func cart() async throws -> CommerceCart { try await request("v1/cart", method: "POST") }
  public func add(_ id: String, quantity: Int = 1) async throws -> CommerceCart {
    let revision = epoch
    _ = try await cart()
    guard revision == epoch else { throw CommerceFailure(401, "Session changed") }
    return try await request(
      "v1/cart/items", method: "POST",
      body: data(["product_id": Self.identifier(id), "quantity": quantity]))
  }
  public func quantity(_ id: String, quantity: Int) async throws -> CommerceCart {
    try await request(
      "v1/cart/items/\(Self.identifier(id))", method: quantity == 0 ? "DELETE" : "PUT",
      body: quantity == 0 ? nil : data(["quantity": quantity]))
  }
  public func locations() async throws -> [CustomerLocation] {
    try await request("v1/customer/locations")
  }
  public func saveLocation(
    pin: DeliveryPin, address: String, building: String, floor: String, apartment: String,
    instructions: String, locationMethod: String = "pin", geography: [String: String]? = nil
  ) async throws -> CustomerLocation {
    try await request(
      "v1/customer/locations", method: "POST",
      body: data([
        "label": "home", "latitude": pin.latitude, "longitude": pin.longitude,
        "formatted_address": address, "building": building, "floor": floor, "apartment": apartment,
        "delivery_instructions": instructions, "is_default": true,
        "location_method": locationMethod, "geography": geography as Any? ?? NSNull(),
      ]))
  }
  public func coverage(_ pin: DeliveryPin) async throws -> DeliveryCoverage {
    return try checked(await raw("v1/delivery-area", delivery: pin))
  }
  public func fulfillment() async throws -> FulfillmentAvailability {
    try await request("v1/fulfillment/availability")
  }
  private func fulfillmentBody(
    method: String, location: String?, source: String?, date: String, asap: Bool
  ) -> [String: Any] {
    [
      "method": method, "location_id": location as Any? ?? NSNull(),
      "source_id": source as Any? ?? NSNull(), "date": date, "asap": asap,
    ]
  }
  public func deliveryOptions(
    method: String, location: String?, source: String?, date: String, asap: Bool
  ) async throws -> FulfillmentOptions {
    try await request(
      "v1/fulfillment/plan-options", method: "POST",
      body: data(
        fulfillmentBody(method: method, location: location, source: source, date: date, asap: asap))
    )
  }
  public func reserveDelivery(
    method: String, location: String?, source: String?, date: String, asap: Bool,
    windows: [FulfillmentSlot], key: String
  ) async throws {
    let _: Acknowledgement = try await request(
      "v1/fulfillment/plans", method: "POST",
      body: data([
        "request": fulfillmentBody(
          method: method, location: location, source: source, date: date, asap: asap),
        "windows": windows.map {
          [
            "schedule_id": $0.schedule_id, "source_id": $0.source_id, "starts_at": $0.starts_at,
            "ends_at": $0.ends_at,
          ]
        }, "idempotency_key": key,
      ]))
  }
  public func quote(location: String?, giftMessage: String = "") async throws -> CommerceQuote {
    guard giftMessage.utf8.count <= 500 else { throw CommerceFailure(422, "Please shorten your gift message") }
    return try await request(
      "v1/customer/checkout/quote", method: "POST",
      body: data(["location_id": location as Any? ?? NSNull(), "gift_message": giftMessage]))
  }
  private func savedAttempts() throws -> [String: CheckoutAttempt] {
    guard let stored = try attempts.readChecked() else { return [:] }
    return try JSONDecoder().decode([String: CheckoutAttempt].self, from: Data(stored.utf8))
  }
  private func saveAttempt(_ attempt: CheckoutAttempt?, customerID: String) throws {
    var all = try savedAttempts()
    all[customerID] = attempt
    try attempts.save(
      all.isEmpty ? nil : String(decoding: JSONEncoder().encode(all), as: UTF8.self))
  }
  public func pendingCheckout() throws -> CheckoutAttempt? {
    guard let customer else { return nil }
    return try savedAttempts()[customer.id]
  }
  public func place(_ quote: CommerceQuote) async throws -> CustomerOrderDetail {
    guard let customer else { throw CommerceFailure(401, "Please sign in") }
    let pending = try pendingCheckout()
    if let pending, pending.quote.id != quote.id {
      throw CommerceFailure(
        409, "Resolve the previous checkout attempt before placing another order")
    }
    let attempt =
      pending ?? CheckoutAttempt(customerID: customer.id, quote: quote, key: UUID().uuidString)
    try saveAttempt(attempt, customerID: customer.id)
    // Persist before sending. Logout and refresh expiry must not discard an uncertain order.
    do {
      let detail: CustomerOrderDetail = try await request(
        "v1/customer/checkout/place", method: "POST",
        body: data(["quote_id": quote.id, "idempotency_key": attempt.key]))
      try saveAttempt(nil, customerID: customer.id)
      return detail
    } catch let failure as CommerceFailure where failure.status == 400 {
      // The checkout transaction checks an existing key BEFORE quote validation.
      // A 400 from that endpoint definitively rejected this attempt before commit.
      try saveAttempt(nil, customerID: customer.id)
      throw failure
    }
  }
  public func orders(offset: Int = 0) async throws -> [CustomerOrder] {
    try await request("v1/customer/orders?offset=\(max(0,offset))")
  }
  public func order(_ id: String) async throws -> CustomerOrderDetail {
    try await request("v1/customer/orders/\(Self.identifier(id))")
  }
  public func categories(locale: String) async throws -> [Category] {
    self.locale = locale == "ar" ? "ar" : "en"
    return try await request("v1/catalog/categories", authenticated: false)
  }
  public func products(category: String?, locale: String) async throws -> [Product] {
    self.locale = locale == "ar" ? "ar" : "en"
    if category?.hasPrefix("demo-feed-") == true { return try await CommerceCatalog(identity: identity, transport: transport).products(category: category, locale: locale) }
    var path = "v1/search?q="
    if let category {
      let id =
        UUID(uuidString: category) != nil
        ? category : try await categories(locale: locale).first(where: { $0.slug == category })?.id
      guard let id else { return [] }
      path += "&category_id=\(try Self.identifier(id))"
    }
    struct Results: Decodable { let hits: [Product] }
    let result: Results = try await request(path, authenticated: false)
    return result.hits
  }
  public func attributes(locale: String) async throws -> [CatalogAttribute] {
    self.locale = locale == "ar" ? "ar" : "en"
    return try await request("v1/catalog/attribute-definitions", authenticated: false)
  }
  public func browse(category: String, filters: CatalogFilters, offset: Int, locale: String) async throws -> CatalogPage {
    guard filters.valid else { throw MobileFailure.invalidResponse }
    self.locale = locale == "ar" ? "ar" : "en"
    let id: String
    if category.isEmpty { id = "" }
    else if UUID(uuidString: category) != nil { id = category }
    else if let match = try await categories(locale: locale).first(where: { $0.slug == category }) { id = match.id }
    else { throw MobileFailure.invalidResponse }
    var query = URLComponents()
    query.queryItems = filters.parameters(category: id, offset: offset)
    return try await request("v1/search?" + (query.percentEncodedQuery ?? ""), authenticated: false)
  }
  public func product(id: String, locale: String) async throws -> Product {
    self.locale = locale == "ar" ? "ar" : "en"
    return try await request("v1/catalog/products/\(Self.identifier(id))", authenticated: false)
  }
  public func coupon(_ code: String) async throws -> CommerceCart {
    try await request("v1/cart/coupon", method: "PUT", body: data(["code": code.trimmingCharacters(in: .whitespacesAndNewlines)]))
  }

  public func family(_ id: String) async throws -> ProductFamily {
    try await request("v1/catalog/products/\(Self.identifier(id))/family", authenticated: false)
  }
  public func comparisonProduct(_ id: String, locale: String) async throws -> ComparisonProduct {
    self.locale = locale
    return try await request("v1/catalog/products/\(Self.identifier(id))", authenticated: false)
  }
  public func reviews(_ id: String, offset: Int = 0) async throws -> [ProductReview] { try await request("v1/products/\(Self.identifier(id))/reviews?offset=\(max(0, offset))", authenticated: false) }
  public func supportTickets() async throws -> [SupportTicket] { try await request("v1/customer/support/tickets") }
  public func assistantHistory(_ id: String? = nil) async throws -> [HistoryTurn] {
    let query = try id.map { "?conversation_id=" + (try Self.identifier($0)) } ?? ""
    let turns: [HistoryTurn] = try await request("v1/assistant/history" + query); try HistoryTurn.validate(turns); return turns
  }
  private func memoryRequest<T: Decodable>(_ path: String, method: String = "GET", body: Data? = nil) async throws -> T {
    if customer == nil, try credentials.readChecked() != nil { _ = try await restore() }
    if customer != nil { return try await request(path, method: method, body: body) }
    let revision = epoch
    let response = try await raw(path, method: method, body: body, memoryGuest: memoryGuest)
    let value: T = try checked(response)
    guard revision == epoch else { throw CommerceFailure(401, "Session changed") }
    let header = response.header("set-cookie") ?? ""
    let regex = try NSRegularExpression(pattern: "(?:^|,\\s*)assistant_guest=([A-Za-z0-9]{48})(?:;|$)")
    if let match = regex.firstMatch(in: header, range: NSRange(header.startIndex..., in: header)), let range = Range(match.range(at: 1), in: header) { memoryGuest = String(header[range]) }
    else if header.contains("assistant_guest=;") { memoryGuest = nil }
    return value
  }
  public func memoryView(_ id: String) async throws -> MemoryView {
    let value: MemoryView = try await memoryRequest("v1/assistant/memory?conversation_id=\(Self.identifier(id))")
    guard !value.enabled || !value.guest || memoryGuest != nil else { throw CommerceFailure(503, "Guest memory session unavailable") }
    return value
  }
  public func savedGoals() async throws -> [SavedGoal] { struct Result: Decodable { let goals: [SavedGoal] }; let result: Result = try await request("v1/cart/saved-goals"); return result.goals }
  public func exportMemory() async throws -> AssistantJSON { try await memoryRequest("v1/assistant/memory/export") }
  public func changeMemory(_ action: MemoryAction) async throws {
    switch action {
    case .consent(let personalized, let journey, let version):
      let _: AssistantJSON = try await memoryRequest("v1/assistant/memory", method: "PUT", body: data(["personalized": personalized, "journey": personalized && journey, "expected_version": version]))
    case .preference(let input):
      _ = try Self.identifier(input.category_id); if let id = input.replaces { _ = try Self.identifier(id) }
      let _: AssistantJSON = try await memoryRequest("v1/assistant/memory/preferences", method: "POST", body: JSONEncoder().encode(input))
    case .removePreference(let id): let _: AssistantJSON = try await memoryRequest("v1/assistant/memory/preferences/\(Self.identifier(id))", method: "DELETE")
    case .clearContext(let id): let _: AssistantJSON = try await memoryRequest("v1/assistant/memory/context/\(Self.identifier(id))", method: "DELETE")
    case .delete: let _: AssistantJSON = try await memoryRequest("v1/assistant/memory", method: "DELETE")
    case .goal(let goal, let name, let archived):
      guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, name.unicodeScalars.count <= 100, name.rangeOfCharacter(from: .controlCharacters) == nil else { throw CommerceFailure(422, "Choose a goal name of 1-100 characters") }
      let _: AssistantJSON = try await request("v1/cart/saved-goals/\(Self.identifier(goal.task_id))", method: "PUT", body: data(["name": name, "archived": archived, "expected_version": goal.version]))
    case .deleteGoal(let goal): let _: AssistantJSON = try await request("v1/cart/saved-goals/\(Self.identifier(goal.task_id))?version=\(goal.version)", method: "DELETE")
    }
  }
  public func supportDetail(_ id: String) async throws -> SupportDetail { try await request("v1/customer/support/tickets/\(Self.identifier(id))") }
  public func createSupport(_ input: SupportInput) async throws -> SupportDetail {
    guard input.valid(signedIn: customer != nil) else { throw CommerceFailure(422, "Complete the support form") }
    _ = try Self.identifier(input.request_id); if let id = input.order_id { _ = try Self.identifier(id) }
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let body = try encoder.encode(input)
    if customer != nil { return try await request("v1/support/tickets", method: "POST", body: body) }
    let revision = epoch
    if supportGuest == nil {
      let response = try await raw("v1/support/session", method: "POST")
      let _: Acknowledgement = try checked(response)
      let header = response.header("set-cookie") ?? ""
      let regex = try NSRegularExpression(pattern: "(?:^|,\\s*)support_guest=([A-Za-z0-9]{48})(?:;|$)")
      guard let match = regex.firstMatch(in: header, range: NSRange(header.startIndex..., in: header)), let range = Range(match.range(at: 1), in: header) else { throw CommerceFailure(502, "Unable to establish a support session") }
      guard revision == epoch else { throw CommerceFailure(401, "Session changed") }; supportGuest = String(header[range])
    }
    let response = try await raw("v1/support/tickets", method: "POST", body: body, supportGuest: supportGuest)
    guard revision == epoch else { throw CommerceFailure(401, "Session changed") }; return try checked(response)
  }
  public func replySupport(_ id: String, requestID: String, body: String) async throws -> SupportDetail {
    guard supportTextValid(body, max: 2000) else { throw CommerceFailure(422, "Enter a message within 2000 bytes") }
    return try await request("v1/customer/support/tickets/\(Self.identifier(id))/messages", method: "POST", body: data(["request_id": Self.identifier(requestID), "body": body]))
  }
  public func ownReview(_ id: String) async throws -> ProductReview? { try await request("v1/customer/products/\(Self.identifier(id))/review") }
  public func submitReview(_ id: String, input: ReviewInput) async throws -> ProductReview {
    guard customer?.verified == true, input.valid else { throw CommerceFailure(422, "Verify your account and complete a valid review") }
    return try await request("v1/customer/products/\(Self.identifier(id))/review", method: "PUT", body: JSONEncoder().encode(input))
  }
  public func relationships(_ sources: [String], kind: String, locale: String) async throws -> [Product] {
    guard (1...50).contains(sources.count), ["related", "upsell", "cross_sell"].contains(kind) else { throw CommerceFailure(422, "Invalid product relationship query") }
    self.locale = locale
    var query = URLComponents()
    query.queryItems = [URLQueryItem(name: "sources", value: try Set(sources.map(Self.identifier)).sorted().joined(separator: ",")), URLQueryItem(name: "kind", value: kind)]
    return try await request("v1/catalog/relationships?" + (query.percentEncodedQuery ?? ""), authenticated: customer != nil)
  }
  public nonisolated func imageURL(_ id: String) -> URL? {
    guard UUID(uuidString: id) != nil else { return nil }
    return URL(
      string: identity.commerceBaseURL.absoluteString.trimmingCharacters(
        in: CharacterSet(charactersIn: "/")) + "/v1/catalog/media/\(id)/content?width=480")
  }

}
