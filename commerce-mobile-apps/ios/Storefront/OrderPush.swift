import RocentoCore
import SwiftUI
import UIKit
import UserNotifications

/// APNs credentials and entitlement are supplied by the owner's signed build, never Studio.
@MainActor final class OrderPush: ObservableObject {
  static let shared = OrderPush()
  @Published private(set) var enabled = false
  @Published private(set) var busy = false
  @Published private(set) var status = ""
  @Published var pendingOrder: String?
  private var pendingOwner: String?
  private var owner: String?
  private var client: CommerceClient?
  private var token: String?
  private let defaults = UserDefaults.standard
  var configured: Bool { Bundle.main.object(forInfoDictionaryKey: "RocentoPushEnabled") as? String == "YES" }
  private func key(_ owner: String) -> String { "storefront.push.\(owner)" }
  private func installation(_ owner: String) -> String {
    let name = key(owner) + ".id"
    if let id = defaults.string(forKey: name), UUID(uuidString: id) != nil { return id }
    let id = UUID().uuidString; defaults.set(id, forKey: name); return id
  }
  func attach(_ client: CommerceClient) { self.client = client }
  func session(_ customer: String?) async {
    if owner != customer { enabled = false; status = ""; owner = customer }
    if let customer, let pendingOwner, pendingOwner != customer { pendingOrder = nil }
    await refresh()
  }
  func refresh() async {
    guard configured, let owner else { enabled = false; return }
    guard defaults.bool(forKey: key(owner)) else { await disable(); return }
    let settings = await UNUserNotificationCenter.current().notificationSettings()
    guard settings.authorizationStatus == .authorized else {
      enabled = false; status = "permission"
      if let client { try? await client.unregisterPushDevice(installation(owner)) }
      return
    }
    UIApplication.shared.registerForRemoteNotifications()
    if let token { await register(token, owner: owner) }
  }
  func enable() async {
    guard configured, let owner, !busy else { return }
    do {
      let allowed = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
      guard self.owner == owner else { return }
      guard allowed else { status = "permission"; return }
      defaults.set(true, forKey: key(owner)); await refresh()
    } catch { status = "retry" }
  }
  func disable() async {
    guard let owner else { return }
    defaults.set(false, forKey: key(owner)); enabled = false
    UIApplication.shared.unregisterForRemoteNotifications()
    UNUserNotificationCenter.current().removeAllDeliveredNotifications()
    guard let client, !busy else { return }
    busy = true; defer { busy = false }
    do { try await client.unregisterPushDevice(installation(owner)); status = "" }
    catch { status = "retry" }
  }
  func logout() async { await disable(); owner = nil; pendingOrder = nil; pendingOwner = nil }
  func receivedToken(_ data: Data) async {
    token = data.map { String(format: "%02x", $0) }.joined()
    if let owner, let token, defaults.bool(forKey: key(owner)) { await register(token, owner: owner) }
  }
  private func register(_ token: String, owner: String) async {
    guard !busy, let client, self.owner == owner else { return }
    busy = true; defer { busy = false }
    do {
      try await client.registerPushDevice(installation(owner), appID: Bundle.main.bundleIdentifier ?? "", token: token, customerID: owner)
      guard self.owner == owner, defaults.bool(forKey: key(owner)) else {
        try? await client.unregisterPushDevice(installation(owner)); return
      }
      enabled = true; status = ""
    } catch { enabled = false; status = "retry" }
  }
  func failed() { enabled = false; status = "retry" }
  func open(order: String?, customer: String?) {
    guard let order, UUID(uuidString: order) != nil,
      let customer, UUID(uuidString: customer) != nil else { return }
    pendingOwner = customer
    // A cold start may still be restoring the customer's session.
    guard owner == nil || owner == customer else { return }
    pendingOrder = order
  }
  func canOpen(for customer: String?) -> Bool { customer != nil && customer == pendingOwner }
}

@MainActor final class OrderPushDelegate: NSObject, UIApplicationDelegate {
  private let notifications = OrderNotificationDelegate()
  func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    UNUserNotificationCenter.current().delegate = notifications; return true
  }
  func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
    Task { @MainActor in await OrderPush.shared.receivedToken(deviceToken) }
  }
  func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
    Task { @MainActor in OrderPush.shared.failed() }
  }
}

/// Notification callbacks may arrive off the main actor. Only typed, sendable
/// identifiers cross into the UI owner; SDK objects stay in their callback.
private final class OrderNotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
  func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
    let order = response.notification.request.content.userInfo["order_id"] as? String
    let customer = response.notification.request.content.userInfo["customer_id"] as? String
    await MainActor.run { OrderPush.shared.open(order: order, customer: customer) }
  }
  func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
    let customer = notification.request.content.userInfo["customer_id"] as? String
    return await MainActor.run {
      let push = OrderPush.shared
      return push.enabled && push.canPresent(customer) ? [.banner, .sound] : []
    }
  }
}
extension OrderPush {
  fileprivate func canPresent(_ customer: String?) -> Bool { customer == owner && owner != nil }
}

struct OrderPushSettings: View {
  @ObservedObject private var push = OrderPush.shared
  let locale: String
  let signedIn: Bool
  private func t(_ en: String, _ ar: String) -> String { locale == "ar" ? ar : en }
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Toggle(t("Order push notifications", "إشعارات الطلبات الفورية"), isOn: Binding(get: { push.enabled }, set: { value in Task { if value { await push.enable() } else { await push.disable() } } }))
        .disabled(!push.configured || !signedIn || push.busy).accessibilityIdentifier("order-push-toggle")
      if !push.configured { Text(t("Push notifications need merchant setup.", "تحتاج الإشعارات الفورية إلى إعداد المتجر.")) }
      else if !signedIn { Text(t("Sign in to enable order notifications.", "سجّل الدخول لتفعيل إشعارات الطلبات.")) }
      else if push.status == "permission" {
        Button(t("Allow notifications in iOS Settings", "السماح بالإشعارات في إعدادات iOS")) {
          if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
        }
      } else if push.status == "retry" {
        Text(t("Could not sync notification settings. Retry when connected.", "تعذرت مزامنة إعدادات الإشعارات. أعد المحاولة عند الاتصال."))
        Button(t("Retry", "إعادة المحاولة")) { Task { await push.refresh() } }
      }
    }.font(.callout)
  }
}
