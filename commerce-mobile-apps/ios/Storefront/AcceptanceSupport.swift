#if DEBUG
  import Foundation
  import RocentoCore

  /// Only compiled into Debug. XCTest supplies isolated data; no route can fall back to a network.
  actor AcceptanceTransport: HTTPTransport {
    let fixture: [String: Any]
    var added = false
    var quantity = 1
    var coupon = ""
    var saved: [String] = []
    var ordered = false
    var loginAttempts = 0
    var orderReads = 0
    var placeAttempts = 0
    var checkoutKey: String?
    var scenario: String { fixture["scenario"] as? String ?? "happy" }
    init?(json: String?) {
      guard let json, json.utf8.count < 100_000, let data = json.data(using: .utf8),
        let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
      else { return nil }
      fixture = value
    }
    func stream(_ request: URLRequest, maxBytes: Int,
      onResponse: @Sendable (HTTPResult) async throws -> Void,
      onChunk: @Sendable (Data) async throws -> Bool) async throws {
      guard request.url?.path == "/api/v1/assistant/chat", let body = request.httpBody,
        let input = try JSONSerialization.jsonObject(with: body) as? [String: Any],
        let requestID = input["request_id"] as? String else { throw URLError(.unsupportedURL) }
      try await onResponse(HTTPResult(status: 200, headers: ["Content-Type": "text/event-stream"]))
      let arabic = request.value(forHTTPHeaderField: "X-Storefront-Locale") == "ar"
      let checkout = (input["message"] as? String)?.lowercased() == "checkout"
      let variant = fixture["variant"] as! [String: Any]
      let productID = variant["id"] as! String
      let product: [String: Any] = ["id": productID, "name": arabic ? "تفاح الاختبار — ١ كجم" : "Fixture apples — 1 kg", "image_id": NSNull(), "price": "25.00", "currency": "EGP", "in_stock": true, "route": "/products/" + productID, "attributes": [], "reasons": [], "unmet": []]
      let values: [[String: Any]] = checkout
        ? [["type": "message.delta", "text": "Review your checkout", "code": "open_checkout", "response_source": "R"], ["type": "done"]]
        : [["type": "progress", "stage": "catalog"], ["type": "message.delta", "text": arabic ? "وجدت لك " : "I found ", "response_source": "R"], ["type": "message.delta", "text": arabic ? "هذا المنتج." : "a fresh pick.", "response_source": "R"], ["type": "content.blocks", "blocks": [["kind": "product_card", "products": [product], "sources": [["kind": "catalog", "product_id": productID, "route": "/products/" + productID]]]]], ["type": "done"]]
      for (index, value) in values.enumerated() {
        if scenario == "assistant-interrupted" && value["type"] as? String == "done" { return }
        try await Task.sleep(nanoseconds: scenario == "assistant-slow" ? 2_000_000_000 : 350_000_000)
        var event = value; event["version"] = "1"; event["request_id"] = requestID; event["sequence"] = index
        var data = Data("data: ".utf8); data.append(try JSONSerialization.data(withJSONObject: event)); data.append(Data("\n\n".utf8))
        if try await onChunk(data) { return }
      }
    }
    func get(_ request: URLRequest, maxBytes: Int) async throws -> HTTPResult {
      let path = request.url!.path.replacingOccurrences(of: "/api/v1/", with: "")
      let ids = fixture["ids"] as! [String: String]
      var value: Any = [:]
      var headers: [String: String] = [:]
      func failure(_ status: Int, _ message: String) throws -> HTTPResult {
        HTTPResult(status: status, body: try JSONSerialization.data(withJSONObject: ["error": message]))
      }
      if path == "customer/auth/login" {
        loginAttempts += 1
        if scenario == "invalid-login" && loginAttempts == 1 { return try failure(401, "Invalid credentials") }
      }
      if path == "customer/orders" { orderReads += 1 }
      if scenario == "expired-session" && (path == "customer/auth/refresh" || path == "customer/orders" && orderReads > 1) {
        return try failure(401, "Please sign in")
      }
      if scenario == "changed-price" && path == "customer/checkout/place" {
        return try failure(400, "Price changed. Review your bag again.")
      }
      if scenario == "outside-area" && path == "delivery-area" {
        return HTTPResult(status: 200, body: try JSONSerialization.data(withJSONObject: ["configured": true, "deliverable": false]))
      }
      if path == "cart/items/\(ids["variant"]!)" {
        quantity = request.httpMethod == "DELETE" ? 0 : ((try JSONSerialization.jsonObject(with: request.httpBody!)) as! [String: Int])["quantity"]!
        added = quantity > 0
      }
      switch path {
      case "customer/auth/login", "customer/auth/refresh":
        value = fixture["auth"]!
        headers["Set-Cookie"] =
          "customer_refresh=" + String(repeating: "f", count: 64) + "; Secure; HttpOnly"
      case "customer/me": value = fixture["customer"]!
      case "catalog/categories": value = fixture["categories"]!
      case "theme/storefront": value = ["configuration": ["pages": ["home": fixture["demo_home"]!]]]
      case "search": value = ["hits": [fixture["product"]!]]
      case "catalog/products/\(ids["product"]!)": value = fixture["product"]!
      case "catalog/products/\(ids["variant"]!)": value = fixture["variant"]!
      case "catalog/products/\(ids["product"]!)/family": value = fixture["family"]!
      case "customer/wishlist": value = saved
      case "customer/wishlist/\(ids["variant"]!)":
        if scenario == "save-failed" { return try failure(503, "Unable to save this product") }
        saved = request.httpMethod == "PUT" ? [ids["variant"]!] : []
      case "cart/coupon":
        coupon = ((try JSONSerialization.jsonObject(with: request.httpBody!)) as? [String: String])?["code"] ?? ""
        value = fixture[added && !ordered ? "cart" : "empty_cart"]!
      case "cart", "cart/items/\(ids["variant"]!)": value = fixture[added && !ordered ? "cart" : "empty_cart"]!
      case "cart/items":
        added = true
        quantity = 1
        value = fixture["cart"]!
      case "customer/locations":
        value = fixture[request.httpMethod == "POST" ? "location" : "locations"]!
      case "delivery-area": value = fixture["coverage"]!
      case "fulfillment/availability": value = fixture["availability"]!
      case "fulfillment/plan-options": value = fixture["options"]!
      case "fulfillment/plans": value = fixture["plan"]!
      case "customer/checkout/quote": value = fixture["quote"]!
      case "customer/checkout/place":
        placeAttempts += 1
        let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
        let key = body["idempotency_key"] as! String
        if let checkoutKey, checkoutKey != key { return try failure(409, "Checkout retry changed its key") }
        checkoutKey = key
        if scenario == "interrupted-checkout" && placeAttempts == 1 { throw URLError(.timedOut) }
        ordered = true
        value = fixture["detail"]!
      case "customer/orders": value = ordered ? [fixture["order"]!] : []
      case "customer/orders/\(ids["order"]!)":
        var detail = fixture["detail"] as! [String: Any]
        var order = detail["order"] as! [String: Any]
        order["status"] = "delivered"
        detail["order"] = order
        value = detail
      case "customer/auth/register": value = fixture["customer"]!
      case "customer/auth/verify", "customer/auth/forgot-password", "customer/auth/reset-password", "customer/auth/request-verification", "customer/auth/logout": break
      default: throw URLError(.unsupportedURL)
      }
      if var cart = value as? [String: Any], cart["id"] as? String == ids["cart"], added && !ordered {
        var item = (cart["items"] as! [[String: Any]])[0]
        item["quantity"] = quantity
        item["reserved_quantity"] = scenario == "stock-shortfall" ? 0 : quantity
        item["line_total"] = String(format: "%.2f", Double(quantity * 25))
        cart["items"] = [item]; cart["subtotal"] = item["line_total"]
        cart["fully_reserved"] = scenario != "stock-shortfall"
        cart["discount_amount"] = coupon == "SAVE5" ? "5.00" : "0.00"
        cart["coupon_code"] = coupon.isEmpty ? NSNull() : coupon as Any
        cart["coupon_error"] = coupon.isEmpty || coupon == "SAVE5" ? NSNull() : "This code is not valid" as Any
        value = cart
      }
      func localized(_ input: Any) -> Any {
        if let array = input as? [Any] { return array.map(localized) }
        guard var object = input as? [String: Any] else { return input }
        for (key, child) in object { object[key] = localized(child) }
        if scenario == "sold-out" && object["id"] as? String == ids["variant"] { object["in_stock"] = false }
        if request.value(forHTTPHeaderField: "X-Storefront-Locale") == "ar", let name = object["name"] as? String {
          object["name"] = ["Fixture apples": "تفاح الاختبار", "Fixture apples — 1 kg": "تفاح الاختبار — ١ كجم", "Fixture fruit": "فاكهة الاختبار"][name] ?? name
        }
        return object
      }
      return HTTPResult(
        status: 200, headers: headers, body: try JSONSerialization.data(withJSONObject: localized(value)))
    }
  }
  final class AcceptanceCredential: CredentialStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var value: String?
    func read() -> String? {
      lock.lock()
      defer { lock.unlock() }
      return value
    }
    func save(_ value: String?) throws {
      lock.lock()
      defer { lock.unlock() }
      self.value = value
    }
  }
#endif
