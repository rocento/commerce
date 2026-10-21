import MapKit
import RocentoCore
import SwiftUI

struct NativePreferencesView: View {
  @ObservedObject var shopping: ShoppingModel
  let locale: String
  let screen: String
  var toggleLanguage: () -> Void
  var back: () -> Void
  var settings: () -> Void
  var openOrder: (String) -> Void
  private var store: NotificationsStore { shopping.session.notifications }
  private var updates: Bool { store.state.enabled }
  private var read: Set<String> { store.state.read }
  private var unreadOnly: Bool { store.state.unreadOnly }
  private var events: [InboxUpdate] { store.state.events }
  private func t(_ en: String, _ ar: String) -> String { locale == "ar" ? ar : en }
  private func mark(_ ids: [String]) { store.mark(ids) }
  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      Button(t("My account", "حسابي"), action: back)
      Text(screen == "settings" ? t("App settings", "إعدادات التطبيق") : t("Notifications", "الإشعارات")).font(.title2.bold())
      if screen == "settings" {
        Text(t("Language", "اللغة")).font(.headline)
        Picker(t("App language", "لغة التطبيق"), selection: Binding(get: { locale }, set: { if $0 != locale { toggleLanguage() } })) {
          Text("English").tag("en"); Text("العربية").tag("ar")
        }
        Divider()
        Text(t("Notifications", "الإشعارات")).font(.headline)
        Toggle(t("Show order updates", "عرض تحديثات الطلبات"), isOn: Binding(get: { updates }, set: { store.setEnabled($0) }))
        OrderPushSettings(locale: locale, signedIn: shopping.customer != nil)
        Divider()
        Text(t("Privacy", "الخصوصية")).font(.headline)
        Toggle(t("Share anonymous usage analytics", "مشاركة إحصاءات استخدام مجهولة"), isOn: Binding(
          get: { shopping.analyticsEnabled }, set: { value in Task { await shopping.consent(value) } }))
        Text(t("Optional screen and checkout counts. No account, order, search or location details are sent.", "إحصاءات اختيارية للشاشات وإتمام الشراء. لا تُرسل بيانات الحساب أو الطلب أو البحث أو الموقع.")).font(.caption)
      } else {
        let unread = events.filter { !read.contains($0.id) }
        Picker(t("Filter notifications", "تصفية الإشعارات"), selection: Binding(get: { unreadOnly }, set: { store.filterUnread($0) })) {
          Text(t("All", "الكل")).tag(false)
          Text(t("Unread", "غير المقروءة") + " (\(unread.count))").tag(true)
        }.pickerStyle(.segmented)
        Button(t("Mark all read", "تحديد الكل كمقروء")) { mark(events.map(\.id)) }.disabled(unread.isEmpty || !updates)
        if !updates {
          Text(t("Order updates are paused", "تحديثات الطلبات متوقفة")).font(.headline)
          Button(t("Notification settings", "إعدادات الإشعارات"), action: settings)
        } else if shopping.customer == nil {
          Text(t("Sign in to see order updates", "سجّل الدخول لعرض تحديثات الطلبات"))
        } else if (unreadOnly ? unread : events).isEmpty {
          Text(unreadOnly ? t("You’re all caught up", "قرأت كل التحديثات") : t("No updates yet", "لا توجد تحديثات بعد")).font(.headline)
        } else {
          ForEach(unreadOnly ? unread : events) { event in
            Button { mark([event.id]); openOrder(event.order) } label: {
              HStack(alignment: .top, spacing: 12) {
                Circle().fill(read.contains(event.id) ? Color.clear : Color.accentColor).frame(width: 8, height: 8).padding(.top, 6)
                  .accessibilityLabel(read.contains(event.id) ? t("Read", "مقروء") : t("Unread", "غير مقروء"))
                VStack(alignment: .leading, spacing: 8) {
                  Text(CommercePresentation.status(event.status, locale: locale)).font(.headline)
                  Text(t("Order", "طلب") + " #\(event.number)")
                  Text(CommercePresentation.dateTime(event.date, locale: locale)).font(.caption)
                  Text(t("View order", "عرض الطلب"))
                }
              }.frame(maxWidth: .infinity, alignment: .leading)
            }.buttonStyle(.plain)
            Divider()
          }
        }
        if store.state.loading { ProgressView() }
        if store.state.failed { Text(t("Unable to load updates. Please retry.", "تعذر تحميل التحديثات. حاول مجدداً.")).foregroundStyle(.red) }
        if store.state.hasMore { Button(t("Load more updates", "عرض المزيد من التحديثات")) { Task { await shopping.refreshNotifications(more: true) } }.disabled(shopping.busy || !updates) }
        Button(t("Refresh updates", "تحديث الإشعارات")) { Task { await shopping.refreshNotifications() } }
          .disabled(!updates || shopping.customer == nil || shopping.busy)
        OrderPushSettings(locale: locale, signedIn: shopping.customer != nil)
      }
    }.task(id: "\(screen):\(shopping.customer?.id ?? "guest")") {
      store.bind(shopping.customer?.id)
      if screen == "notifications" && updates { await shopping.refreshNotifications() }
    }
  }
}

