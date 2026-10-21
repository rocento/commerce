import XCTest

@MainActor final class StorefrontUITests: XCTestCase {
  func testKeychainUpgradeSeed() throws { try keychainUpgrade("seed") }
  func testKeychainUpgradeRestore() throws { try keychainUpgrade("restore") }
  func testKeychainUpgradeFinish() throws { try keychainUpgrade("finish") }
  private func keychainUpgrade(_ phase: String) throws {
    guard ProcessInfo.processInfo.environment["ROCENTO_KEYCHAIN_UPGRADE"] == "1" else {
      throw XCTSkip("Run the signed Keychain upgrade acceptance procedure")
    }
    let app = XCUIApplication()
    app.launchEnvironment["ROCENTO_KEYCHAIN_UPGRADE_PHASE"] = phase
    let fixture = Bundle(for: Self.self).url(forResource: "commerce-flow", withExtension: "json")!
    app.launchEnvironment["ROCENTO_TEST_COMMERCE"] = try String(contentsOf: fixture, encoding: .utf8)
    app.launch()
    let status = app.staticTexts["keychain-upgrade-result"]
    XCTAssertTrue(status.waitForExistence(timeout: 15))
    let ready = NSPredicate(format: "label == %@", "PASS " + phase)
    expectation(for: ready, evaluatedWith: status)
    waitForExpectations(timeout: 20)
    app.terminate()
  }
  private var production: Bool {
    Bundle(for: Self.self).object(forInfoDictionaryKey: "RocentoProduction") as? String == "YES"
  }
  private func app(arabic: Bool = false, largeText: Bool = false, scenario: String = "happy") -> XCUIApplication {
    let app = XCUIApplication()
    if production {
      let url = Bundle(for: Self.self).url(forResource: "commerce-flow", withExtension: "json")!
      var fixture = try! JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
      fixture["scenario"] = scenario
      if scenario == "discounted-product" {
        for key in ["product", "variant"] {
          var product = fixture[key] as! [String: Any]
          product["catalog_offer"] = ["product_id": product["id"]!, "currency": "EGP", "original_price": "25.00", "discounted_price": "19.00"]
          fixture[key] = product
        }
        fixture["family"] = ["children": [fixture["variant"]!]]
      }
      if scenario == "quote-snapshot" {
        var quote = fixture["quote"] as! [String: Any]
        var snapshot = quote["snapshot"] as! [String: Any]
        snapshot["location"] = ["formatted_address": "Server-reviewed pickup address", "custom_label": "Server-reviewed branch", "location_method": "pickup"]
        snapshot["items"] = [["product_id": "reviewed-product", "name": "Server-reviewed basket", "quantity": 2, "price": "12.50", "line_total": "25.00"]]
        snapshot["fulfillment_plan"] = ["method": "pickup", "groups": [["source_id": "reviewed-source", "source_name": "Server-reviewed branch", "schedule_id": "reviewed-slot", "starts_at": "2026-10-15T12:00:00Z", "ends_at": "2026-10-15T13:00:00Z", "timezone": "Africa/Cairo"]]]
        quote["snapshot"] = snapshot; fixture["quote"] = quote
      }
      app.launchEnvironment["ROCENTO_TEST_COMMERCE"] = String(data: try! JSONSerialization.data(withJSONObject: fixture), encoding: .utf8)!
    }
    app.launchArguments = ["-storefront.language", arabic ? "ar" : "en", "-AppleInterfaceStyle", "Dark"]
    if arabic {
      app.launchArguments += ["-rocento-ar"]
    }
    if largeText { app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"] }
    app.launch()
    return app
  }
  private func tap(_ element: XCUIElement, in app: XCUIApplication) {
    // Lazy grids do not expose off-screen cells until scrolled. A partially
    // obscured button can also report hittable behind the custom bottom bar.
    _ = element.waitForExistence(timeout: 2)
    let bar = app.otherElements.matching(identifier: "bottom-navigation").firstMatch
    func visible() -> Bool {
      guard element.exists, element.isHittable else { return false }
      // Form controls use XCTest's keyboard-aware scroll-to-visible behavior.
      // Catalog/variant buttons need the explicit overlay check.
      let catalogControl = element.identifier.hasPrefix("product-") || element.identifier.hasPrefix("variant-")
      return !catalogControl || !bar.exists || element.frame.midY < bar.frame.minY
    }
    for _ in 0..<8 {
      if visible() { break }
      // Start inside the content, above navigation and the software keyboard.
      // A whole-window swipe can land on either overlay and never scroll.
      let frame = app.frame
      let bottom = bar.exists ? bar.frame.minY : frame.maxY
      let startY = min(bottom - 24, frame.minY + frame.height * 0.5)
      let endY = max(frame.minY + 100, startY - 200)
      let origin = app.coordinate(withNormalizedOffset: .zero)
      // Use the content gutter so dragging does not refocus a text field.
      origin.withOffset(CGVector(dx: 8, dy: startY - frame.minY))
        .press(forDuration: 0.05, thenDragTo: origin.withOffset(CGVector(dx: 8, dy: endY - frame.minY)))
    }
    guard visible() else {
      evidence(app, "Unreachable test control")
      XCTFail("Control did not become visible: \(element)")
      return
    }
    element.tap()
  }
  func testAccountHomeGuestAndCustomer() throws { try accountHome(arabic: false) }
  func testDiscountedProductUsesOfferInDetailAndPurchase() throws {
    guard production else { throw XCTSkip("Isolated commerce fixture only") }
    let application = app(scenario: "discounted-product")
    login(application); selectVariant(application)
    let prices = application.staticTexts.matching(identifier: "product-offer-price")
    XCTAssertTrue(prices.firstMatch.waitForExistence(timeout: 10))
    XCTAssertEqual(prices.count, 2)
    for price in prices.allElementsBoundByIndex { XCTAssertTrue(price.label.contains("19.00"), price.label) }
    evidence(application, "Offer price in details and purchase controls")
  }
  func testQuoteReviewUsesServerDestinationAndItems() throws {
    guard production else { throw XCTSkip("Isolated commerce fixture only") }
    let application = app(scenario: "quote-snapshot")
    login(application); selectVariant(application); review(application)
    XCTAssertEqual(application.staticTexts["review-address"].label, "Server-reviewed pickup address")
    XCTAssertTrue(application.staticTexts["Server-reviewed basket"].exists)
    XCTAssertTrue(application.staticTexts["Pickup"].exists)
    evidence(application, "Immutable quote review")
  }
  func testIsolatedLaunchPerformance() throws {
    guard production else { throw XCTSkip("Isolated commerce fixture only") }
    let options = XCTMeasureOptions()
    options.iterationCount = 3
    measure(metrics: [XCTApplicationLaunchMetric(waitUntilResponsive: true)], options: options) {
      let application = app()
      XCTAssertTrue(application.buttons["tab-home"].waitForExistence(timeout: 15))
      application.terminate()
    }
  }
  func testPreviewParityScreens() throws {
    guard production else { throw XCTSkip("Isolated commerce fixture only") }
    let app = app()
    XCTAssertTrue(app.buttons["tab-home"].waitForExistence(timeout: 15))
    evidence(app, "parity-home")
    for (tab, name) in [("categories", "categories"), ("deals", "deals"), ("cart", "cart-empty"), ("account", "account-guest")] {
      tap(app.buttons["tab-" + tab], in: app); evidence(app, "parity-" + name)
    }
    tap(app.buttons["account-notifications"], in: app); evidence(app, "parity-notifications")
    tap(app.buttons["My account"], in: app)
    tap(app.buttons["App settings"], in: app); evidence(app, "parity-settings")
    tap(app.buttons["My account"], in: app)
    login(app)
    XCTAssertTrue(app.buttons["account-addresses"].waitForExistence(timeout: 10))
    evidence(app, "parity-account-customer")
    for (id, name) in [("account-addresses", "addresses"), ("account-orders", "orders")] {
      tap(app.buttons[id], in: app); evidence(app, "parity-" + name); tap(app.buttons["account-home"], in: app)
    }
    selectVariant(app); evidence(app, "parity-product-variants")
    tap(app.buttons["add-to-bag"], in: app)
    XCTAssertTrue(app.staticTexts["commerce-notice"].waitForExistence(timeout: 10))
    tap(app.buttons["close-product"], in: app)
    tap(app.buttons["tab-cart"], in: app); evidence(app, "parity-cart")
    tap(app.buttons["tab-home"], in: app)
    tap(app.buttons["open-assistant"], in: app); evidence(app, "parity-assistant")
  }
  func testArabicAccountHomeGuestAndCustomer() throws { try accountHome(arabic: true) }
  private func accountHome(arabic: Bool) throws {
    guard production else { throw XCTSkip("Production commerce target only") }
    let app = app(arabic: arabic)
    tap(app.buttons[arabic ? "الحساب" : "Account"], in: app)
    let signIn = app.buttons["account-sign-in"]
    let register = app.buttons["account-register"]
    XCTAssertTrue(signIn.waitForExistence(timeout: 10))
    XCTAssertEqual(signIn.frame.minX, register.frame.minX, accuracy: 1)
    XCTAssertEqual(signIn.frame.width, register.frame.width, accuracy: 1)
    XCTAssertFalse(app.buttons["account-sign-out"].exists)
    evidence(app, arabic ? "account-guest-ar" : "account-guest-en")
    tap(signIn, in: app)
    tap(app.textFields["customer-identifier"], in: app)
    app.textFields["customer-identifier"].typeText("native-fixture@example.test")
    tap(app.secureTextFields["customer-password"], in: app)
    app.secureTextFields["customer-password"].typeText("test-only-password\n")
    tap(app.buttons["customer-submit"], in: app)
    XCTAssertTrue(app.buttons["account-addresses"].waitForExistence(timeout: 10))
    evidence(app, arabic ? "account-customer-ar" : "account-customer-en")
    tap(app.buttons["account-addresses"], in: app)
    XCTAssertTrue(app.buttons[arabic ? "إضافة عنوان توصيل" : "Add delivery address"].exists)
    tap(app.buttons["account-home"], in: app)
    tap(app.buttons["account-orders"], in: app)
    XCTAssertTrue(app.staticTexts[arabic ? "لا توجد طلبات بعد" : "No orders yet"].exists)
    tap(app.buttons["account-home"], in: app)
    tap(app.buttons["account-language-row"], in: app)
    XCTAssertTrue(app.segmentedControls["account-language"].exists)
    tap(app.buttons["account-home"], in: app)
    tap(app.buttons["account-sign-out"], in: app)
    XCTAssertTrue(signIn.waitForExistence(timeout: 10))
  }
  func testBottomNavigationSpansScreenWidth() throws {
    let app = app()
    let bar = app.otherElements["bottom-navigation"]
    XCTAssertTrue(bar.waitForExistence(timeout: 15))
    XCTAssertEqual(bar.frame.minX, app.frame.minX, accuracy: 1)
    XCTAssertEqual(bar.frame.width, app.frame.width, accuracy: 1)
    for tab in ["home", "categories", "deals", "account", "cart"] {
      XCTAssertTrue(app.buttons["tab-" + tab].exists)
    }
    tap(app.buttons["tab-account"], in: app)
    XCTAssertTrue(app.buttons["tab-account"].isSelected)
    tap(app.buttons["tab-home"], in: app)
    XCTAssertTrue(app.buttons["tab-home"].isSelected)
    evidence(app, "Full-width iOS bottom navigation")
  }
  func testConfiguredButtonRadiusCapture() throws {
    guard production else { throw XCTSkip("Production commerce target only") }
    let control = URL(fileURLWithPath: "/private/tmp/rocento-button-radius-token.txt")
    guard FileManager.default.fileExists(atPath: control.path) else { throw XCTSkip("Explicit radius verification only") }
    let token = try String(contentsOf: control, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
    let application = app()
    tap(application.buttons["tab-account"], in: application)
    let button = application.buttons["customer-submit"]
    XCTAssertTrue(button.waitForExistence(timeout: 15))
    for _ in 0..<8 { if button.isHittable { break }; application.swipeUp() }
    let folder = URL(fileURLWithPath: "/private/tmp/rocento-button-radius-ios")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    try button.screenshot().pngRepresentation.write(to: folder.appendingPathComponent(token + "-primary.png"))
    try application.screenshot().pngRepresentation.write(to: folder.appendingPathComponent(token + "-account.png"))
    application.terminate()
  }
  func testNativeNotificationPreferences() throws {
    guard production else { throw XCTSkip("Production commerce target only") }
    let app = app(); login(app); selectVariant(app); review(app)
    tap(app.buttons["place-order"], in: app)
    XCTAssertTrue(app.staticTexts["order-confirmation"].waitForExistence(timeout: 10))
    tap(app.buttons["Account"], in: app)
    tap(app.buttons["account-notifications"], in: app)
    tap(app.buttons["Mark all read"], in: app)
    tap(app.buttons["Unread (0)"], in: app)
    XCTAssertTrue(app.staticTexts["You’re all caught up"].exists)
    tap(app.buttons["Refresh updates"], in: app)
    XCTAssertTrue(app.staticTexts["You’re all caught up"].exists)
    let inbox = XCTAttachment(screenshot: app.screenshot()); inbox.name = "Native notification inbox"; inbox.lifetime = .keepAlways; add(inbox)
    // Return to the top of the scroll content before leaving the inbox.
    app.swipeDown(); tap(app.buttons["My account"], in: app)
    tap(app.buttons["App settings"], in: app)
    tap(app.switches["Show order updates"], in: app)
    XCTAssertEqual(app.switches["Show order updates"].value as? String, "0")
    let settings = XCTAttachment(screenshot: app.screenshot()); settings.name = "Native settings"; settings.lifetime = .keepAlways; add(settings)
    app.swipeDown(); tap(app.buttons["My account"], in: app)
    tap(app.buttons["account-notifications"], in: app)
    XCTAssertTrue(app.staticTexts["Order updates are paused"].waitForExistence(timeout: 10))
    tap(app.buttons["Notification settings"], in: app)
    tap(app.switches["Show order updates"], in: app)
    XCTAssertEqual(app.switches["Show order updates"].value as? String, "1")
  }
  func testAssistantProductCartAndCheckout() throws { try assistantFlow(arabic: false) }
  func testArabicAssistantProductCartAndCheckout() throws { try assistantFlow(arabic: true) }
  private func assistantFlow(arabic: Bool) throws {
    guard production else { throw XCTSkip("Production commerce target only") }
    let app = app(arabic: arabic)
    login(app, arabic: arabic)
    XCTAssertTrue(app.staticTexts["native-fixture@example.test"].waitForExistence(timeout: 10))
    tap(app.buttons["tab-home"], in: app)
    tap(app.buttons["open-assistant"], in: app)
    let input = app.descendants(matching: .any).matching(identifier: "assistant-input").firstMatch
    tap(input, in: app); input.typeText("Show apples")
    tap(app.buttons["assistant-send"], in: app)
    XCTAssertTrue(app.staticTexts["assistant-reply"].waitForExistence(timeout: 10))
    let add = app.buttons["assistant-add-70000000-0000-0000-0000-000000000010"]
    let enabled = NSPredicate(format: "enabled == true")
    expectation(for: enabled, evaluatedWith: add)
    waitForExpectations(timeout: 15)
    tap(add, in: app)
    XCTAssertTrue(app.staticTexts["assistant-cart-notice"].waitForExistence(timeout: 10))
    evidence(app, arabic ? "Arabic native assistant product" : "English native assistant product")
    tap(input, in: app); input.typeText("Checkout")
    tap(app.buttons["assistant-send"], in: app)
    XCTAssertTrue(app.buttons["cart-checkout"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.staticTexts["order-confirmation"].exists)
    XCTAssertFalse(app.buttons["place-order"].exists)
    evidence(app, arabic ? "Arabic assistant checkout handoff" : "English assistant checkout handoff")
    if !app.buttons["delivery-options"].exists { tap(app.buttons["cart-checkout"], in: app) }
    tap(app.buttons["delivery-options"], in: app)
    tap(app.buttons["review-order"], in: app)
    XCTAssertTrue(app.buttons["place-order"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["place-order"].isEnabled)
    XCTAssertFalse(app.staticTexts["order-confirmation"].exists)
    for _ in 0..<8 {
      if app.buttons["place-order"].isHittable { break }
      app.swipeUp()
    }
    evidence(app, arabic ? "Arabic assistant checkout review" : "English assistant checkout review")
  }
  func testAssistantProductOpensNativeDetails() throws {
    guard production else { throw XCTSkip("Production commerce target only") }
    let app = app()
    tap(app.buttons["open-assistant"], in: app)
    let input = app.descendants(matching: .any).matching(identifier: "assistant-input").firstMatch
    tap(input, in: app); input.typeText("Show apples")
    tap(app.buttons["assistant-send"], in: app)
    tap(app.buttons["assistant-product-70000000-0000-0000-0000-000000000010"], in: app)
    XCTAssertTrue(app.staticTexts["product-detail-title"].waitForExistence(timeout: 10))
    XCTAssertEqual(app.sheets.count, 0)
    XCTAssertTrue(app.navigationBars.buttons["close-product"].isHittable)
    tap(app.buttons["close-product"], in: app)
    tap(app.buttons["open-assistant"], in: app)
    XCTAssertTrue(app.staticTexts["assistant-reply"].waitForExistence(timeout: 10))
  }
  func testAssistantInterruptedResponseDoesNotNavigate() throws {
    guard production else { throw XCTSkip("Production commerce target only") }
    let app = app(scenario: "assistant-interrupted")
    tap(app.buttons["open-assistant"], in: app)
    let input = app.descendants(matching: .any).matching(identifier: "assistant-input").firstMatch
    tap(input, in: app); input.typeText("Checkout")
    tap(app.buttons["assistant-send"], in: app)
    XCTAssertTrue(app.staticTexts["assistant-interrupted"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["assistant-close"].exists)
    XCTAssertFalse(app.staticTexts["order-confirmation"].exists)
  }
  func testAssistantCanStopResponse() throws {
    guard production else { throw XCTSkip("Production commerce target only") }
    let app = app(scenario: "assistant-slow")
    tap(app.buttons["open-assistant"], in: app)
    let input = app.descendants(matching: .any).matching(identifier: "assistant-input").firstMatch
    tap(input, in: app); input.typeText("Show apples")
    tap(app.buttons["assistant-send"], in: app)
    tap(app.buttons["assistant-stop"], in: app)
    XCTAssertTrue(app.staticTexts["assistant-interrupted"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["assistant-send"].exists)
  }
  func testGuestProductRequiresDeliveryAddress() throws {
    guard production else { throw XCTSkip("Production commerce target only") }
    let app = app()
    tap(app.buttons.matching(identifier: "product-70000000-0000-0000-0000-000000000002").firstMatch, in: app)
    tap(app.buttons["choose-product-address"], in: app)
    XCTAssertTrue(app.buttons["account-sign-in"].waitForExistence(timeout: 10))
  }
  func testRegistrationAndRecoverySteps() throws { try registrationAndRecovery(arabic: false) }
  func testArabicRegistrationAndRecoverySteps() throws { try registrationAndRecovery(arabic: true) }
  private func registrationAndRecovery(arabic: Bool) throws {
    guard production else { throw XCTSkip("Production commerce target only") }
    let app = app(arabic: arabic)
    tap(app.buttons[arabic ? "الحساب" : "Account"], in: app)
    tap(app.buttons["account-register"], in: app)
    tap(app.textFields["customer-identifier"], in: app)
    app.textFields["customer-identifier"].typeText("native-fixture@example.test")
    tap(app.secureTextFields["customer-password"], in: app)
    dismissPasswordEducation(app)
    app.secureTextFields["customer-password"].typeText("test-only-password")
    tap(app.buttons["customer-submit"], in: app)
    XCTAssertTrue(app.staticTexts["account-validation"].exists)
    tap(app.secureTextFields["customer-confirm-password"], in: app)
    dismissPasswordEducation(app)
    app.secureTextFields["customer-confirm-password"].typeText("test-only-password")
    tap(app.buttons["customer-submit"], in: app)
    XCTAssertTrue(app.textFields["customer-code"].waitForExistence(timeout: 10))
    tap(app.textFields["customer-code"], in: app)
    app.textFields["customer-code"].typeText("fixture-verification-token")
    tap(app.buttons["customer-submit"], in: app)
    XCTAssertTrue(app.buttons["account-forgot"].waitForExistence(timeout: 10))
    tap(app.buttons["account-forgot"], in: app)
    XCTAssertFalse(app.secureTextFields["customer-password"].exists)
    tap(app.buttons["customer-submit"], in: app)
    XCTAssertTrue(app.textFields["customer-code"].waitForExistence(timeout: 10))
    tap(app.secureTextFields["customer-password"], in: app)
    dismissPasswordEducation(app)
    app.secureTextFields["customer-password"].typeText("new-test-password")
    tap(app.secureTextFields["customer-confirm-password"], in: app)
    dismissPasswordEducation(app)
    app.secureTextFields["customer-confirm-password"].typeText("new-test-password")
    tap(app.textFields["customer-code"], in: app)
    app.textFields["customer-code"].typeText("fixture-reset-token")
    tap(app.buttons["customer-submit"], in: app)
    XCTAssertTrue(app.buttons["account-register"].waitForExistence(timeout: 10))
    XCTAssertEqual(app.secureTextFields["customer-password"].value as? String, arabic ? "كلمة المرور" : "Password")
  }
  private func dismissPasswordEducation(_ app: XCUIApplication) {
    let generate = app.buttons["GenerateStrongPasswordButton"]
    if generate.waitForExistence(timeout: 1) { app.buttons["xmark"].tap() }
  }
  private func login(_ app: XCUIApplication, arabic: Bool = false) {
    continueAfterFailure = false
    tap(app.buttons[arabic ? "الحساب" : "Account"], in: app)
    tap(app.buttons["account-sign-in"], in: app)
    tap(app.textFields["customer-identifier"], in: app)
    app.textFields["customer-identifier"].typeText("native-fixture@example.test")
    tap(app.secureTextFields["customer-password"], in: app)
    app.secureTextFields["customer-password"].typeText("test-only-password")
    tap(app.buttons["customer-submit"], in: app)
  }
  private func selectVariant(_ app: XCUIApplication, arabic: Bool = false) {
    XCTAssertTrue(app.staticTexts["native-fixture@example.test"].waitForExistence(timeout: 10))
    tap(app.buttons[arabic ? "الرئيسية" : "Home"], in: app)
    tap(app.buttons.matching(identifier: "product-70000000-0000-0000-0000-000000000002").firstMatch, in: app)
    tap(app.buttons["variant-70000000-0000-0000-0000-000000000010"], in: app)
  }
  private func review(_ app: XCUIApplication, arabic: Bool = false) {
    tap(app.buttons["add-to-bag"], in: app)
    XCTAssertTrue(app.staticTexts["commerce-notice"].waitForExistence(timeout: 10))
    tap(app.buttons["close-product"], in: app)
    tap(app.buttons[arabic ? "السلة" : "Cart"], in: app)
    if !app.buttons["delivery-options"].exists { tap(app.buttons["cart-checkout"], in: app) }
    tap(app.buttons["delivery-options"], in: app)
    tap(app.buttons["review-order"], in: app)
    XCTAssertTrue(app.buttons["place-order"].waitForExistence(timeout: 10))
    for _ in 0..<8 {
      if app.buttons["place-order"].isHittable { break }
      app.swipeUp()
    }
    XCTAssertTrue(app.otherElements["checkout-total"].exists || app.staticTexts["checkout-total"].exists)
    XCTAssertTrue(app.staticTexts[arabic ? "الدفع عند الاستلام" : "Cash on delivery"].exists)
    XCTAssertTrue(app.staticTexts["quote-expiry"].label.contains(arabic ? "٢٠٣٠" : "2030"))
    XCTAssertFalse(app.staticTexts["quote-expiry"].label.contains("T00:"))
    XCTAssertFalse(app.staticTexts["order-confirmation"].exists)
  }
  private func evidence(_ app: XCUIApplication, _ name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
  }
  private func completeFlow(arabic: Bool) throws {
    guard production else { throw XCTSkip("Production commerce target only") }
    let app = app(arabic: arabic)
    login(app, arabic: arabic); selectVariant(app, arabic: arabic); review(app, arabic: arabic)
    evidence(app, arabic ? "Arabic checkout review" : "English checkout review")
    tap(app.buttons["place-order"], in: app)
    XCTAssertTrue(app.staticTexts["order-confirmation"].waitForExistence(timeout: 10))
    tap(app.buttons[arabic ? "تحديث الحالة" : "Refresh status"], in: app)
    XCTAssertTrue(app.staticTexts[arabic ? "تم التوصيل" : "Delivered"].waitForExistence(timeout: 10))
    XCTAssertEqual(app.staticTexts["order-status"].label, arabic ? "تم التوصيل" : "Delivered")
    XCTAssertTrue(app.staticTexts["order-date"].label.contains(arabic ? "أكتوبر" : "Oct"))
    XCTAssertFalse(app.staticTexts["order-date"].label.contains("T00:"))
    let history = app.staticTexts["order-history-70000000-0000-0000-0000-000000000009"].label
    XCTAssertTrue(history.contains(arabic ? "تم استلام الطلب" : "Order placed"))
    XCTAssertTrue(history.contains(arabic ? "٢٠٢٦" : "2026"))
    evidence(app, arabic ? "Arabic order tracking" : "English order tracking")
    tap(app.buttons[arabic ? "الحساب" : "Account"], in: app)
    let orderStatus = app.staticTexts["order-list-status-70000000-0000-0000-0000-000000000007"]
    XCTAssertTrue(orderStatus.label.contains(arabic ? "تم استلام الطلب" : "Order placed"))
    let orderDate = app.staticTexts["order-list-date-70000000-0000-0000-0000-000000000007"]
    XCTAssertTrue(orderDate.label.contains(arabic ? "أكتوبر" : "Oct"))
    tap(app.buttons["account-language-row"], in: app)
    tap(app.segmentedControls["account-language"].buttons[arabic ? "English" : "العربية"], in: app)
    tap(app.buttons["account-home"], in: app)
    let switchedStatus = NSPredicate(format: "label CONTAINS %@", arabic ? "Order placed" : "تم استلام الطلب")
    expectation(for: switchedStatus, evaluatedWith: orderStatus)
    waitForExpectations(timeout: 10)
    XCTAssertTrue(orderDate.label.contains(arabic ? "Oct" : "أكتوبر"))
    tap(app.buttons["account-language-row"], in: app)
    tap(app.segmentedControls["account-language"].buttons[arabic ? "العربية" : "English"], in: app)
    tap(app.buttons["account-home"], in: app)
    tap(app.buttons["account-sign-out"], in: app)
    XCTAssertTrue(app.buttons["account-sign-in"].waitForExistence(timeout: 10))
  }
  func testLightCartCheckout() throws { try lightCartCheckout(arabic: false) }
  func testArabicLightCartCheckout() throws { try lightCartCheckout(arabic: true) }
  private func lightCartCheckout(arabic: Bool) throws {
    guard production else { throw XCTSkip("Production commerce target only") }
    let app = app(arabic: arabic)
    login(app, arabic: arabic); selectVariant(app, arabic: arabic)
    tap(app.buttons["add-to-bag"], in: app); tap(app.buttons["close-product"], in: app)
    tap(app.buttons["tab-cart"], in: app)
    XCTAssertTrue(app.staticTexts["cart-items-total"].waitForExistence(timeout: 10))
    XCTAssertLessThanOrEqual(app.buttons["cart-checkout"].frame.maxY, app.otherElements["bottom-navigation"].frame.minY)
    evidence(app, arabic ? "light-cart-ar" : "light-cart-en")
    tap(app.buttons["cart-checkout"], in: app)
    tap(app.buttons["delivery-options"], in: app); tap(app.buttons["review-order"], in: app)
    XCTAssertTrue(app.buttons["place-order"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.staticTexts["order-confirmation"].exists)
    evidence(app, arabic ? "light-checkout-ar" : "light-checkout-en")
    tap(app.buttons["place-order"], in: app)
    XCTAssertTrue(app.staticTexts["order-confirmation"].waitForExistence(timeout: 10))
    tap(app.buttons[arabic ? "تحديث الحالة" : "Refresh status"], in: app)
    XCTAssertTrue(app.staticTexts[arabic ? "تم التوصيل" : "Delivered"].waitForExistence(timeout: 10))
  }
  func testFailedSaveKeepsCartItem() throws {
    guard production else { throw XCTSkip("Production commerce target only") }
    let app = app(scenario: "save-failed"); login(app); selectVariant(app)
    tap(app.buttons["add-to-bag"], in: app); tap(app.buttons["close-product"], in: app)
    tap(app.buttons["tab-cart"], in: app)
    tap(app.buttons["cart-save-70000000-0000-0000-0000-000000000010"], in: app)
    XCTAssertTrue(app.staticTexts["commerce-error"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["cart-items-total"].label.contains("25.00"))
    XCTAssertFalse(app.staticTexts["cart-empty"].exists)
  }
  func testCartCouponAndSaveForLater() throws {
    guard production else { throw XCTSkip("Production commerce target only") }
    let app = app(); login(app); selectVariant(app)
    tap(app.buttons["add-to-bag"], in: app); tap(app.buttons["close-product"], in: app)
    tap(app.buttons["tab-cart"], in: app)
    // XCTest considers the offscreen coupon row hittable beneath the fixed
    // checkout dock. Scroll the content above that dock before tapping it.
    let couponButton = app.buttons["cart-coupon"]
    for _ in 0..<4 {
      if couponButton.frame.maxY < app.buttons["cart-checkout"].frame.minY - 80 { break }
      app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.55))
        .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25)))
    }
    tap(app.buttons["cart-coupon"], in: app)
    tap(app.textFields["cart-coupon-input"], in: app)
    app.textFields["cart-coupon-input"].typeText("SAVE5")
    tap(app.buttons["cart-coupon-apply"], in: app)
    XCTAssertTrue(app.buttons["Remove code"].waitForExistence(timeout: 10))
    tap(app.buttons["Done"], in: app)
    expectation(for: NSPredicate(format: "label CONTAINS %@", "20.00"), evaluatedWith: app.staticTexts["cart-items-total"])
    waitForExpectations(timeout: 10)
    evidence(app, "light-cart-coupon")
    tap(app.buttons["cart-save-70000000-0000-0000-0000-000000000010"], in: app)
    XCTAssertTrue(app.staticTexts["cart-empty"].waitForExistence(timeout: 10))
    tap(app.buttons["cart-saved"], in: app)
    XCTAssertTrue(app.buttons["remove-saved-70000000-0000-0000-0000-000000000010"].waitForExistence(timeout: 10))
  }
  func testProductionCommerceConfirmation() throws { try completeFlow(arabic: false) }
  func testArabicCompleteCommerceFlow() throws { try completeFlow(arabic: true) }
  func testRejectedLoginCanRetry() throws {
    guard production else { throw XCTSkip("Production commerce target only") }
    let app = app(scenario: "invalid-login"); login(app)
    XCTAssertTrue(app.staticTexts["commerce-error"].waitForExistence(timeout: 10))
    XCTAssertEqual(app.textFields["customer-identifier"].value as? String, "native-fixture@example.test")
    tap(app.buttons["customer-submit"], in: app)
    XCTAssertTrue(app.staticTexts["native-fixture@example.test"].waitForExistence(timeout: 10))
  }
  func testSoldOutVariantCannotBeAdded() throws {
    guard production else { throw XCTSkip("Production commerce target only") }
    let app = app(scenario: "sold-out"); login(app); selectVariant(app)
    XCTAssertTrue(app.buttons["add-to-bag"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["add-to-bag"].isEnabled)
  }
  func testOutsideDeliveryAreaIsRejected() throws {
    guard production else { throw XCTSkip("Production commerce target only") }
    let app = app(scenario: "outside-area"); login(app); selectVariant(app)
    tap(app.buttons["add-to-bag"], in: app); tap(app.buttons["close-product"], in: app)
    tap(app.buttons["Cart"], in: app)
    tap(app.buttons["cart-checkout"], in: app)
    tap(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Fixture delivery street")).firstMatch, in: app)
    XCTAssertTrue(app.staticTexts["commerce-error"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["place-order"].exists)
  }
  func testChangedPriceRequiresNewReview() throws {
    guard production else { throw XCTSkip("Production commerce target only") }
    let app = app(scenario: "changed-price"); login(app); selectVariant(app); review(app)
    tap(app.buttons["place-order"], in: app)
    XCTAssertTrue(app.staticTexts["commerce-error"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["place-order"].exists)
    XCTAssertFalse(app.staticTexts["order-confirmation"].exists)
  }
  func testInterruptedCheckoutCanSafelyRetry() throws {
    guard production else { throw XCTSkip("Production commerce target only") }
    let app = app(scenario: "interrupted-checkout"); login(app); selectVariant(app); review(app)
    tap(app.buttons["place-order"], in: app)
    XCTAssertTrue(app.staticTexts["commerce-error"].waitForExistence(timeout: 10))
    tap(app.buttons["place-order"], in: app)
    XCTAssertTrue(app.staticTexts["order-confirmation"].waitForExistence(timeout: 10))
  }
  func testExpiredSessionReturnsToSignIn() throws {
    guard production else { throw XCTSkip("Production commerce target only") }
    let app = app(scenario: "expired-session"); login(app)
    XCTAssertTrue(app.staticTexts["native-fixture@example.test"].waitForExistence(timeout: 10))
    tap(app.buttons["account-orders"], in: app)
    tap(app.buttons["Refresh orders"], in: app)
    XCTAssertTrue(app.buttons["account-sign-in"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["place-order"].exists)
  }
  func testCartQuantityAndRemoval() throws {
    guard production else { throw XCTSkip("Production commerce target only") }
    let app = app(); login(app); selectVariant(app)
    tap(app.buttons["add-to-bag"], in: app); tap(app.buttons["close-product"], in: app)
    tap(app.buttons["Cart"], in: app)
    tap(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Add one ")).firstMatch, in: app)
    XCTAssertTrue(app.staticTexts["cart-items-total"].waitForExistence(timeout: 10))
    expectation(for: NSPredicate(format: "label CONTAINS %@", "50.00"), evaluatedWith: app.staticTexts["cart-items-total"]); waitForExpectations(timeout: 10)
    tap(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Remove one ")).firstMatch, in: app)
    expectation(for: NSPredicate(format: "label CONTAINS %@", "25.00"), evaluatedWith: app.staticTexts["cart-items-total"]); waitForExpectations(timeout: 10)
    tap(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Remove one ")).firstMatch, in: app)
    XCTAssertTrue(app.staticTexts["Your bag is empty"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["delivery-options"].exists)
  }
  func testStockShortfallBlocksCheckout() throws {
    guard production else { throw XCTSkip("Production commerce target only") }
    let app = app(scenario: "stock-shortfall"); login(app); selectVariant(app)
    tap(app.buttons["add-to-bag"], in: app); tap(app.buttons["close-product"], in: app)
    tap(app.buttons["Cart"], in: app)
    XCTAssertTrue(app.buttons["cart-checkout"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["cart-checkout"].isEnabled)
    XCTAssertFalse(app.buttons["place-order"].exists)
  }
  func testCategoryFiltersAndBackNavigation() throws {
    if production { throw XCTSkip("Preview catalog target only") }
    let app = app()
    tap(app.buttons["Categories"], in: app)
    let category = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "category-")).firstMatch
    tap(category, in: app)
    tap(app.buttons["Filter & sort"], in: app)
    let query = app.textFields["category-query"]
    tap(query, in: app); query.typeText("no-matching-product")
    XCTAssertFalse(app.buttons["Apply filters"].exists)
    XCTAssertTrue(app.staticTexts["No products match. Try resetting the filters."].waitForExistence(timeout: 5))
    tap(app.buttons["Reset"], in: app)
    XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "product-")).firstMatch.waitForExistence(timeout: 5))
    app.navigationBars.buttons.element(boundBy: 0).tap()
    XCTAssertTrue(category.waitForExistence(timeout: 5))
  }
  func testCatalogToProductAndArabicNavigation() throws {
    if production { throw XCTSkip("Preview catalog target only") }
    let app = XCUIApplication()
    app.launch()
    let product = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "product-"))
      .firstMatch
    XCTAssertTrue(product.waitForExistence(timeout: 15))
    product.tap()
    XCTAssertTrue(app.staticTexts["product-detail-title"].waitForExistence(timeout: 5))
    app.buttons["close-product"].tap()
    app.terminate()
    app.launchArguments += ["-rocento-ar"]
    app.launch()
    XCTAssertTrue(app.buttons["hero-hero_1"].exists)
    app.buttons["hero-hero_1"].tap()
    XCTAssertTrue(app.buttons["تصفية وترتيب"].waitForExistence(timeout: 5))
    app.buttons["تصفية وترتيب"].tap()
    XCTAssertTrue(app.textFields["category-query"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["الأقسام"].isSelected)
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = "Arabic collection"
    attachment.lifetime = .keepAlways
    add(attachment)
  }
  func testArabicLaunchAndLargeText() {
    if production {
      let app = app(arabic: true, largeText: true)
      tap(app.buttons["الحساب"], in: app)
      XCTAssertTrue(app.buttons["account-sign-in"].waitForExistence(timeout: 10))
      let attachment = XCTAttachment(screenshot: app.screenshot())
      attachment.name = "Arabic commerce accessibility text"
      attachment.lifetime = .keepAlways
      add(attachment)
      return
    }
    let app = XCUIApplication()
    app.launchArguments = [
      "-rocento-ar", "-UIPreferredContentSizeCategoryName",
      "UICTContentSizeCategoryAccessibilityXXXL",
    ]
    app.launch()
    XCTAssertTrue(app.buttons["hero-hero_1"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["الرئيسية"].exists)
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = "Arabic accessibility text"
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}

// Append to the existing StorefrontUITests.swift only for the coordinated release checks.
extension StorefrontUITests {
  func testRuntime12MerchantScreens() throws {
    let controlURL = URL(fileURLWithPath: "/private/tmp/rocento-runtime12-ios-control.json")
    guard FileManager.default.fileExists(atPath: controlURL.path) else { throw XCTSkip("Explicit runtime 1.2 release capture only") }
    let settings = try JSONSerialization.jsonObject(with: Data(contentsOf: controlURL)) as! [String: Any]
    let draft = settings["draft"] as! Bool
    let mode = draft ? "draft" : "published"
    let stores = settings["stores"] as! [String]
    let snapshots = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: "/Users/momar/Documents/commerce-ai/output/rocento-runtime-1-2-20261012/snapshot.json"))) as! [String: [String: Any]]
    var invitations: [String: [String: String]] = [:]
    if !draft, let path = settings["invitations"] as? String {
      invitations = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as! [String: [String: String]]
    }
    let output = URL(fileURLWithPath: "/private/tmp/rocento-runtime12-ios-\(mode)")
    try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
    for store in stores {
      let app = XCUIApplication(bundleIdentifier: "com.rocento.\(store)")
      app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US", "-storefront.language", "en"] + (draft ? ["-rocento-draft-preview"] : [])
      app.launch()
      if !draft {
        tap(app.buttons["Account"], in: app)
        tap(app.buttons["App connection"], in: app)
        if let code = invitations[store]?["ios"] {
          let field = app.secureTextFields["enrollment-code"]
          tap(field, in: app); field.typeText(code)
          tap(app.buttons["enrollment-connect"], in: app)
          XCTAssertTrue(app.staticTexts["App connected. Pull to refresh published updates."].waitForExistence(timeout: 60))
        }
        let version = store == "grocery" ? 6 : 1
        XCTAssertTrue(app.staticTexts["Published design version \(version)"].waitForExistence(timeout: 60))
        app.terminate(); app.launch()
      }
      let config = (snapshots[store]!["draft"] as! [String: Any])["config"] as! [String: Any]
      let title = (config["brand"] as! [String: Any])["displayName"] as! String
      XCTAssertTrue(app.images[title].firstMatch.waitForExistence(timeout: 30))
      XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "category-")).firstMatch.waitForExistence(timeout: 90), "Merchant catalog should load before capture")
      let folder = output.appendingPathComponent(store)
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      func capture(_ name: String) throws {
        try app.screenshot().pngRepresentation.write(to: folder.appendingPathComponent(name + ".png"))
      }
      try capture("home")
      let feeds = snapshots[store]!["feeds"] as! [String: [String: Any]]
      let expected = Set(feeds.values.flatMap { ($0["products"] as! [[String: Any]]).map { $0["id"] as! String } })
      var seen = Set<String>()
      let steps = settings["homeOnly"] as? Bool == true ? 0 : 18
      for step in 0..<steps {
        for id in expected where app.buttons["product-" + id].firstMatch.exists { seen.insert(id) }
        try capture("step-\(step)")
        app.swipeUp(velocity: .slow)
      }
      if steps > 0 { XCTAssertTrue(expected.isSubset(of: seen), "Missing product nodes for \(store): \(expected.subtracting(seen))") }
      XCTAssertFalse(app.staticTexts["load-error"].exists)
      app.terminate()
      if steps > 0 { print("PASS runtime1.2 \(store) \(mode) all \(seen.count) product nodes inspected") } else { print("PASS runtime1.2 \(store) \(mode) loaded home captured") }
    }
  }
}

// Opt-in, read-only checks against installed merchant apps and their live APIs.
extension StorefrontUITests {
  func testAccountAndDealsAllMerchants() throws {
    let control = URL(fileURLWithPath: "/private/tmp/rocento-account-deals-control.json")
    guard FileManager.default.fileExists(atPath: control.path) else { throw XCTSkip("Explicit merchant screen verification only") }
    let settings = try JSONSerialization.jsonObject(with: Data(contentsOf: control)) as! [String: Any]
    let stores = settings["stores"] as! [String]
    let output = URL(fileURLWithPath: settings["output"] as! String)
    for store in stores {
      let folder = output.appendingPathComponent(store)
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      let app = XCUIApplication(bundleIdentifier: "com.rocento.\(store)")
      for language in ["en", "ar"] {
        app.launchArguments = ["-storefront.language", language]
        app.launch()
        XCTAssertTrue(app.buttons["tab-account"].waitForExistence(timeout: 60))
        app.buttons["tab-account"].tap()
        XCTAssertTrue(app.staticTexts[language == "ar" ? "حسابي" : "My account"].waitForExistence(timeout: 30))
        XCTAssertFalse(app.textFields["header-search"].exists)
        XCTAssertFalse(app.buttons["language-toggle"].exists)
        try app.screenshot().pngRepresentation.write(to: folder.appendingPathComponent("account-\(language).png"))
        tap(app.buttons["account-language-row"], in: app)
        let picker = app.segmentedControls["account-language"]
        let selected = picker.buttons[language == "ar" ? "العربية" : "English"]
        for _ in 0..<8 { if selected.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(selected.exists)
        XCTAssertTrue(selected.isSelected)
        try app.screenshot().pngRepresentation.write(to: folder.appendingPathComponent("preferences-\(language).png"))
        app.buttons["tab-deals"].tap()
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
          !app.activityIndicators["deals-loading"].exists &&
            (app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "product-")).count > 0 ||
             app.staticTexts["deals-empty"].exists || app.staticTexts["deals-error"].exists)
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 120), .completed)
        XCTAssertFalse(app.staticTexts["deals-error"].exists)
        let products = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "product-"))
        if products.count > 0 { XCTAssertTrue(products.firstMatch.label.contains(language == "ar" ? "وفّر" : "Save")) }
        let status = products.count > 0 ? "live offers" : "no eligible offers"
        try status.write(to: folder.appendingPathComponent("deals-\(language)-status.txt"), atomically: true, encoding: .utf8)
        evidence(app, "\(store) deals \(language)")
        try app.screenshot().pngRepresentation.write(to: folder.appendingPathComponent("deals-\(language).png"))
        app.terminate()
      }
    }
  }
}
