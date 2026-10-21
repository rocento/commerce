/// Transient UI destinations only. Product data stays in CatalogStore and order data in OrderStore.
@MainActor public final class NavigationStore {
  public private(set) var tab = "home"
  public private(set) var cartPanel: String?
  public private(set) var panel: String?
  public private(set) var assistantPresented = false
  public private(set) var checkoutPresented = false
  public var onChange: (() -> Void)?
  private var orderReturn: String?
  public init() {}
  public func selectTab(_ value: String) {
    if tab != value { panel = nil; cartPanel = nil; orderReturn = nil; assistantPresented = false; checkoutPresented = false }
    tab = value; onChange?()
  }
  public func open(_ value: String?) {
    if value == "order" && panel != "order" { orderReturn = panel == "orders" ? "orders" : nil }
    if value == "notification-order" { orderReturn = "notifications" }
    if value != "order" && value != "notification-order" { orderReturn = nil }
    panel = value; onChange?()
  }
  public func openCart(_ value: String?) { cartPanel = value; checkoutPresented = value == "checkout"; onChange?() }
  public func presentAssistant(_ value: Bool) { assistantPresented = value; onChange?() }
  public func presentCheckout(_ value: Bool) { openCart(value ? "checkout" : nil) }
  @discardableResult public func back() -> Bool {
    if assistantPresented { assistantPresented = false }
    else if panel != nil { panel = orderReturn; orderReturn = nil }
    else if cartPanel != nil { cartPanel = nil; checkoutPresented = false }
    else if tab != "home" { tab = "home" }
    else { return false }
    onChange?(); return true
  }
  public func resetCustomerRoutes(preserveAuthentication: Bool = false) {
    panel = preserveAuthentication && panel == "auth" ? "auth" : nil
    cartPanel = nil; orderReturn = nil; assistantPresented = false; checkoutPresented = false; onChange?()
  }
}
