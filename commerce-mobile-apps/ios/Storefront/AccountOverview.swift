import RocentoCore
import SwiftUI

// Account home uses the page background; only actionable groups have a border.
struct AccountPanel: ViewModifier {
  func body(content: Content) -> some View {
    content.overlay(RoundedRectangle(cornerRadius: 16).stroke(.primary.opacity(0.1), lineWidth: 1))
  }
}

struct AccountGuestHeader: View {
  let locale: String
  let wishlistEnabled: Bool
  let signIn: () -> Void
  let register: () -> Void
  private func t(_ en: String, _ ar: String) -> String { locale == "ar" ? ar : en }
  var body: some View {
    VStack(spacing: 18) {
      Image("RocentoIcon")
        .resizable().scaledToFit().frame(width: 64, height: 64)
        .accessibilityHidden(true).padding(.top, 10)
      Text(t("Your everyday shop,\nmade easier.", "تسوّقك اليومي،\nبكل سهولة."))
        .font(.title.bold()).multilineTextAlignment(.center).accessibilityAddTraits(.isHeader)
      Text(wishlistEnabled
        ? t("Sign in to track orders, save favourites and check out faster.", "سجّل الدخول لتتبّع طلباتك وحفظ مفضلاتك وإتمام الشراء أسرع.")
        : t("Sign in to track orders and check out faster.", "سجّل الدخول لتتبّع طلباتك وإتمام الشراء أسرع."))
        .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
      VStack(spacing: 10) {
        Button(action: signIn) {
          Text(t("Sign in", "تسجيل الدخول")).font(.headline).frame(maxWidth: .infinity, minHeight: 32)
        }.buttonStyle(.storefrontPrimary).controlSize(.large).accessibilityIdentifier("account-sign-in")
        Button(action: register) {
          Text(t("Create account", "إنشاء حساب")).font(.headline).frame(maxWidth: .infinity, minHeight: 32)
        }.buttonStyle(AccountOutlineButtonStyle()).controlSize(.large).accessibilityIdentifier("account-register")
      }.frame(maxWidth: .infinity)
      HStack(alignment: .top, spacing: 12) {
        benefit("shippingbox", t("Track orders", "تتبّع الطلبات"))
        if wishlistEnabled { benefit("heart", t("Save favourites", "حفظ المفضلات")) }
        benefit("bolt", t("Faster checkout", "شراء أسرع"))
      }.padding(.vertical, 12)
    }.frame(maxWidth: .infinity)
  }
  private func benefit(_ icon: String, _ title: String) -> some View {
    VStack(spacing: 8) {
      Image(systemName: icon).font(.system(size: 25, weight: .regular)).accessibilityHidden(true)
      Text(title).font(.caption).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
    }.frame(maxWidth: .infinity)
  }
}

struct AccountIdentity: View {
  let customer: CustomerAccount
  let locale: String
  var body: some View {
    HStack(spacing: 16) {
      Image(systemName: "person.crop.circle.fill").font(.system(size: 60))
        .foregroundStyle(.tint).accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 6) {
        Text(locale == "ar" ? "مرحباً بعودتك" : "Welcome back").font(.subheadline).foregroundStyle(.secondary)
        Text(customer.identifier).font(.title3.weight(.semibold)).textSelection(.enabled)
          .fixedSize(horizontal: false, vertical: true)
        Label(customer.verified
          ? (locale == "ar" ? "حساب مؤكد" : "Verified account")
          : (locale == "ar" ? "مطلوب تأكيد الحساب" : "Verification needed"),
          systemImage: customer.verified ? "checkmark.seal.fill" : "exclamationmark.circle")
          .font(.caption).foregroundStyle(customer.verified ? Color.accentColor : .secondary)
      }
      Spacer(minLength: 0)
    }.padding(.vertical, 14).frame(maxWidth: .infinity, alignment: .leading)
  }
}

struct AccountShortcut: View {
  let title: String
  let subtitle: String
  let icon: String
  let identifier: String
  let action: () -> Void
  var body: some View {
    Button(action: action) {
      VStack(spacing: 8) {
        Image(systemName: icon).font(.system(size: 25)).accessibilityHidden(true)
        Text(title).font(.subheadline.weight(.semibold))
        Text(subtitle).font(.caption).foregroundStyle(.secondary)
      }.multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, minHeight: 96).padding(.horizontal, 5).padding(.vertical, 8)
        .modifier(AccountPanel()).contentShape(Rectangle())
    }.buttonStyle(.plain).accessibilityIdentifier(identifier)
  }
}

struct AccountOrderCard: View {
  let order: CustomerOrder
  let locale: String
  let open: () -> Void
  private func t(_ en: String, _ ar: String) -> String { locale == "ar" ? ar : en }
  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(alignment: .top, spacing: 12) {
        Image(systemName: "shippingbox").font(.title2).accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 6) {
          Text(t("Order", "طلب") + " #\(order.number)").font(.headline)
          Text(CommercePresentation.status(order.status, locale: locale)).font(.subheadline)
            .foregroundStyle(.tint).accessibilityIdentifier("order-list-status-\(order.id)")
        }
        Spacer(minLength: 0)
      }
      Text(CommercePresentation.dateTime(order.created_at, locale: locale)).font(.caption).foregroundStyle(.secondary)
        .accessibilityIdentifier("order-list-date-\(order.id)")
      Divider()
      ViewThatFits(in: .horizontal) {
        HStack(spacing: 12) { total; Spacer(); track }
        VStack(alignment: .leading, spacing: 12) { total; track }
      }
    }.padding(16).modifier(AccountPanel())
  }
  private var total: some View { Text("\(order.total) \(order.currency)").font(.subheadline.weight(.semibold)) }
  private var track: some View {
    Button(t("Track order", "تتبّع الطلب"), action: open).buttonStyle(.storefrontPrimary)
      .controlSize(.large).accessibilityIdentifier("account-track-\(order.id)")
  }
}

struct AccountPreferences: View {
  let locale: String
  let language: () -> Void
  let notifications: () -> Void
  let settings: () -> Void
  let help: () -> Void
  let signOut: (() -> Void)?
  private func t(_ en: String, _ ar: String) -> String { locale == "ar" ? ar : en }
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text(t("PREFERENCES", "التفضيلات")).font(.caption.weight(.semibold))
        .tracking(locale == "ar" ? 0 : 1.8).foregroundStyle(.secondary)
      VStack(spacing: 0) {
        row(t("Language", "اللغة"), icon: "globe", value: locale == "ar" ? "العربية" : "English", action: language)
          .accessibilityIdentifier("account-language-row")
        Divider().padding(.leading, 52)
        row(t("Notifications", "الإشعارات"), icon: "bell", action: notifications)
        Divider().padding(.leading, 52)
        row(t("App settings", "إعدادات التطبيق"), icon: "gearshape", action: settings)
      }.modifier(AccountPanel())
      Button(action: help) {
        HStack(spacing: 14) {
          Image(systemName: "bubble.left").font(.title2).frame(width: 24).accessibilityHidden(true)
          VStack(alignment: .leading, spacing: 4) {
            Text(t("Need a hand?", "تحتاج مساعدة؟")).font(.subheadline.weight(.semibold))
            Text(t("Help & support", "المساعدة والدعم")).font(.caption).foregroundStyle(.secondary)
          }
          Spacer()
          Image(systemName: "chevron.forward").font(.caption).accessibilityHidden(true)
        }.frame(minHeight: 44).padding(16).background(.tint.opacity(0.06), in: RoundedRectangle(cornerRadius: 16))
      }.buttonStyle(.plain).accessibilityIdentifier("account-help")
      if let signOut {
        Button(action: signOut) { Label(t("Sign out", "تسجيل الخروج"), systemImage: "rectangle.portrait.and.arrow.right")
            .font(.subheadline).frame(minHeight: 44) }
          .buttonStyle(.plain).foregroundStyle(.secondary).accessibilityIdentifier("account-sign-out")
      }
    }.padding(.top, 6)
  }
  private func row(_ title: String, icon: String, value: String? = nil, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack(spacing: 14) {
        Image(systemName: icon).font(.system(size: 23)).frame(width: 24).accessibilityHidden(true)
        Text(title).font(.subheadline)
        Spacer(minLength: 4)
        if let value { Text(value).font(.subheadline).foregroundStyle(.secondary) }
        Image(systemName: "chevron.forward").font(.caption).foregroundStyle(.secondary).accessibilityHidden(true)
      }.frame(minHeight: 28).padding(16).contentShape(Rectangle())
    }.buttonStyle(.plain)
  }
}

private struct AccountOutlineButtonStyle: ButtonStyle {
  @Environment(\.storefrontButtonTheme) private var theme
  @Environment(\.isEnabled) private var enabled
  func makeBody(configuration: Configuration) -> some View {
    let shape = RoundedRectangle(cornerRadius: theme.radius, style: .circular)
    return configuration.label.padding(.horizontal, 16).padding(.vertical, 12).frame(minHeight: 52)
      .foregroundStyle(theme.primary).overlay(shape.strokeBorder(theme.primary, lineWidth: 1))
      .contentShape(shape).opacity(enabled ? (configuration.isPressed ? 0.8 : 1) : 0.45)
  }
}
