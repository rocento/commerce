import MapKit
import RocentoCore
import SwiftUI

struct CommerceView: View {
  @ObservedObject private var orderPush = OrderPush.shared
  @ObservedObject var shopping: ShoppingModel
  let locale: String
  let tab: String
  var toggleLanguage: () -> Void = {}
  var wishlistEnabled = false
  var openHelp: () -> Void = {}
  var accountNavigation: () -> Void = {}
  private var preferenceScreen: String? {
    get { shopping.session.navigation.panel }
    nonmutating set { shopping.session.navigation.open(newValue) }
  }

  var openProduct: (String) -> Void = { _ in }
  var shop: () -> Void = {}
  var openSaved: () -> Void = {}
  @State private var authForm = AuthenticationFormState()
  @State private var accountNotice: String?
  @State private var addingAddress = false
  private enum AccountField: Hashable { case identifier, password, confirmation, code }
  @FocusState private var accountFocus: AccountField?
  private func t(_ en: String, _ ar: String) -> String { locale == "ar" ? ar : en }
  var body: some View {
    Group {
      if tab == "cart" {
        NativeCartView(shopping: shopping, locale: locale, wishlistEnabled: wishlistEnabled,
          openProduct: openProduct, shop: shop, openSaved: openSaved, openAssistant: openHelp,
          signIn: AnyView(signIn))
      } else {
    VStack(alignment: .leading, spacing: 18) {
      if shopping.busy {
        ProgressView().accessibilityLabel(shopping.loading.label(locale))
      }
      if let error = shopping.error {
        Text(error).foregroundStyle(.red).accessibilityIdentifier("commerce-error")
      }
      if let notice = shopping.notice { Text(notice).accessibilityIdentifier("commerce-notice") }
      if tab == "account" {
        accountContent
      } else if let customer = shopping.customer {
        if tab == "wishlist" { NativeWishlistView(shopping: shopping, locale: locale, openProduct: openProduct, shop: shop) }
        else { account(customer) }
      } else { signIn }
    }
      }
    }.disabled(shopping.busy && tab != "cart").task {
      await shopping.client.setLocale(locale)
      await shopping.load()
    }
    .task(id: "\(orderPush.pendingOrder ?? ""):\(shopping.customer?.id ?? "")") {
      guard tab == "account", orderPush.canOpen(for: shopping.customer?.id), let id = orderPush.pendingOrder else { return }
      preferenceScreen = "notification-order"
      shopping.detail = nil
      await shopping.track(id)
      orderPush.pendingOrder = nil
    }
    .onChange(of: preferenceScreen) { _, _ in accountFocus = nil; accountNavigation() }
    .onChange(of: shopping.customer?.id) { old, new in
      if old != new {
        preferenceScreen = nil; authForm.clearSecrets(); accountFocus = nil
        accountNavigation()
      }
    }
    .sheet(isPresented: $addingAddress) { AddressView(shopping: shopping, locale: locale) }
  }
  private func switchMode(_ mode: String) {
    authForm.open(mode)
    accountNotice = nil
    shopping.error = nil
    shopping.notice = nil
  }
  private var authTitle: String {
    switch authForm.mode {
    case "register": return t("Create account", "إنشاء حساب")
    case "verify": return t("Verify account", "تأكيد الحساب")
    case "forgot-password": return t("Forgot password?", "نسيت كلمة المرور؟")
    case "reset-password": return t("Reset password", "إعادة تعيين كلمة المرور")
    default: return t("Sign in", "تسجيل الدخول")
    }
  }
  private func submitAccount() async {
    guard authForm.validate() else { return }
    let submitted = authForm
    accountFocus = nil
    let mode = authForm.mode
    let value = authForm.identifier.trimmingCharacters(in: .whitespacesAndNewlines)
    if mode == "login" {
      await shopping.login(value, authForm.password)
      if shopping.customer != nil { authForm.clearSecrets() }
      return
    }
    let succeeded = await shopping.auth(mode, value,
      password: ["register", "reset-password"].contains(mode) ? authForm.password : nil,
      code: ["verify", "reset-password"].contains(mode) ? authForm.code.trimmingCharacters(in: .whitespacesAndNewlines) : nil)
    guard succeeded else { return }
    guard authForm.complete(submitted) else { return }
    accountNotice = mode == "register"
      ? t("Account created. Check your email or phone for a verification code.", "تم إنشاء الحساب. تحقق من بريدك أو هاتفك للحصول على رمز التحقق.")
      : mode == "forgot-password"
      ? t("If an account matches, you will receive a reset code. Check your inbox and spam folder.", "إذا كان الحساب موجوداً، فسيصلك رمز إعادة التعيين. تحقق من البريد الوارد وغير المرغوب فيه.")
      : mode == "verify"
      ? t("Account verified. Sign in to continue.", "تم تأكيد الحساب. سجل الدخول للمتابعة.")
      : t("Password updated. Sign in with your new password.", "تم تحديث كلمة المرور. سجل الدخول بكلمة المرور الجديدة.")
  }
  private var signIn: some View {
    VStack(alignment: .leading, spacing: 16) {
      Image(systemName: authForm.mode == "login" || authForm.mode == "register" ? "person.crop.circle" : "lock.shield")
        .font(.system(size: 32)).foregroundStyle(.tint)
        .frame(width: 64, height: 64)
        .accessibilityHidden(true)
      Text(authForm.mode == "login" ? t("Welcome back", "مرحباً بعودتك") : authTitle)
        .font(.title.bold()).accessibilityAddTraits(.isHeader)
      Text(t("Manage your orders and delivery addresses securely.", "إدارة طلباتك وعناوين التوصيل بأمان.")).foregroundStyle(.secondary)
      if let accountNotice { Text(accountNotice).accessibilityIdentifier("account-success") }
      Text(t("Email or phone", "البريد أو الهاتف")).font(.subheadline.weight(.medium))
      TextField(t("Email or phone", "البريد أو الهاتف"), text: $authForm.identifier)
        .textContentType(.username).textInputAutocapitalization(.never).autocorrectionDisabled()
        .focused($accountFocus, equals: .identifier).accessibilityIdentifier("customer-identifier")
      Text(t("For phone numbers, include the country code, e.g. +201012345678.", "لأرقام الهاتف، أضف رمز الدولة مثل ‎+201012345678.")).font(.caption)
      if ["login", "register", "reset-password"].contains(authForm.mode) {
        Group {
          if authForm.showPassword { TextField(t("Password", "كلمة المرور"), text: $authForm.password) }
          else { SecureField(t("Password", "كلمة المرور"), text: $authForm.password) }
        }.textContentType(authForm.mode == "login" ? .password : .newPassword)
          .textInputAutocapitalization(.never).autocorrectionDisabled().focused($accountFocus, equals: .password).accessibilityIdentifier("customer-password")
        Toggle(t("Show password", "إظهار كلمة المرور"), isOn: $authForm.showPassword)
        if authForm.mode != "login" {
          Text(t("Use a long, unique password (12–128 UTF-8 bytes).", "استخدم كلمة مرور طويلة وفريدة (١٢–١٢٨ بايت UTF-8).")).font(.caption)
          SecureField(t("Confirm password", "تأكيد كلمة المرور"), text: $authForm.confirmation)
            .textContentType(.newPassword).focused($accountFocus, equals: .confirmation).accessibilityIdentifier("customer-confirm-password")
        }
      }
      if authForm.mode == "verify" || authForm.mode == "reset-password" {
        TextField(t("Verification code", "رمز التحقق"), text: $authForm.code).textContentType(.oneTimeCode)
          .textInputAutocapitalization(.never).autocorrectionDisabled().focused($accountFocus, equals: .code).accessibilityIdentifier("customer-code")
        Button(t("Send a new code", "إرسال رمز جديد")) {
          Task {
            await shopping.auth(authForm.mode == "verify" ? "request-verification" : "forgot-password", authForm.identifier.trimmingCharacters(in: .whitespacesAndNewlines))
            if shopping.error == nil {
              shopping.notice = nil
              accountNotice = t("If eligible, a code will be sent. Check your inbox and spam folder.", "إذا كان الحساب مؤهلاً، فسيُرسل رمز. تحقق من البريد الوارد وغير المرغوب فيه.")
            }
          }
        }.disabled(authForm.identifier.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
      if let validation = authForm.validation {
        Text(validationMessage(validation)).foregroundStyle(.red).accessibilityIdentifier("account-validation")
      }
      Button { Task { await submitAccount() } } label: {
        Text(authForm.mode == "forgot-password" ? t("Send reset code", "إرسال رمز إعادة التعيين") : authTitle)
          .font(.headline).frame(maxWidth: .infinity, minHeight: 32)
      }.buttonStyle(.storefrontPrimary).controlSize(.large).accessibilityIdentifier("customer-submit")
      if authForm.mode == "login" {
        Divider().padding(.vertical, 4)
        Text(t("New here?", "جديد هنا؟")).font(.subheadline).foregroundStyle(.secondary)
        Button { switchMode("register") } label: {
          Text(t("Create account", "إنشاء حساب")).frame(maxWidth: .infinity, minHeight: 32)
        }.buttonStyle(.storefrontSecondary).controlSize(.large).accessibilityIdentifier("account-register")
        Button(t("Forgot password?", "نسيت كلمة المرور؟")) { switchMode("forgot-password") }.accessibilityIdentifier("account-forgot")
        Button(t("Verify an existing account", "تأكيد حساب موجود")) { switchMode("verify") }
      } else {
        Button(t("Back to sign in", "العودة لتسجيل الدخول")) { switchMode("login") }.accessibilityIdentifier("account-back")
      }
    }.frame(maxWidth: .infinity, alignment: .leading)
      .textFieldStyle(.roundedBorder).controlSize(.large)
      .submitLabel(.done)
      .onSubmit { accountFocus = nil }
      .onDisappear { authForm.clearSecrets() }
  }
  private func validationMessage(_ issue: String) -> String {
    switch issue {
    case "identifier": return t("Enter your email or phone number.", "أدخل بريدك الإلكتروني أو رقم هاتفك.")
    case "password": return t("Enter your password.", "أدخل كلمة المرور.")
    case "length": return t("Use a password of 12–128 UTF-8 bytes; Arabic letters may use more than one byte.", "استخدم كلمة مرور من ١٢ إلى ١٢٨ بايت UTF-8؛ قد يستخدم الحرف العربي أكثر من بايت.")
    case "confirmation": return t("Passwords do not match.", "كلمتا المرور غير متطابقتين.")
    default: return t("Enter the verification code you received.", "أدخل رمز التحقق الذي تلقيته.")
    }
  }
  private var accountLanguage: some View {
    VStack(alignment: .leading, spacing: 12) {
      Label(t("Language", "اللغة"), systemImage: "globe").font(.headline)
      Picker(t("Language", "اللغة"), selection: Binding(get: { locale }, set: { if $0 != locale { toggleLanguage() } })) {
        Text("English").tag("en")
        Text("العربية").tag("ar")
      }.pickerStyle(.segmented).accessibilityIdentifier("account-language")
    }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
      .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
  }
  @ViewBuilder private var accountContent: some View {
    if preferenceScreen == "settings" || preferenceScreen == "notifications" {
      NativePreferencesView(shopping: shopping, locale: locale, screen: preferenceScreen!, toggleLanguage: toggleLanguage,
        back: { preferenceScreen = nil }, settings: { preferenceScreen = "settings" },
        openOrder: { id in shopping.detail = shopping.notificationDetails.first { $0.order.id == id }; preferenceScreen = "notification-order" })
    } else if let screen = preferenceScreen {
      Button { shopping.session.navigation.back() } label: {
        Label(t("My account", "حسابي"), systemImage: "chevron.backward").frame(minHeight: 44)
      }.accessibilityIdentifier("account-home")
      if screen == "auth" { signIn }
      else if screen == "language" { accountLanguage }
      else if screen == "deletion" { AccountDeletionView(shopping: shopping, locale: locale) }
      else if screen == "orders" {
        Text(t("Your orders", "طلباتك")).font(.title.bold())
        if shopping.orders.isEmpty { emptyOrders }
        ForEach(shopping.orders.sorted { $0.created_at > $1.created_at }) { order in
          AccountOrderCard(order: order, locale: locale) { openOrder(order.id) }
        }
        Button(t("Refresh orders", "تحديث الطلبات")) { Task { await shopping.refreshOrders() } }
        if shopping.ordersHasMore && !shopping.orders.isEmpty { Button(t("Load more orders", "تحميل المزيد من الطلبات")) { Task { await shopping.refreshOrders(more: true) } } }
      } else if screen == "addresses" {
        Text(t("Addresses", "العناوين")).font(.title.bold())
        if shopping.locations.isEmpty {
          Text(t("Save a delivery address for a faster checkout.", "احفظ عنوان التوصيل لإتمام الشراء أسرع.")).foregroundStyle(.secondary)
        }
        ForEach(shopping.locations) { location in
          Button { Task { await shopping.choose(location.id) } } label: {
            HStack(alignment: .top, spacing: 12) {
              Image(systemName: shopping.selectedLocation == location.id ? "checkmark.circle.fill" : "mappin.circle")
              VStack(alignment: .leading, spacing: 6) {
                Text(location.label).font(.headline)
                Text(location.formatted_address).font(.subheadline)
                if location.is_default { Text(t("Default address", "العنوان الافتراضي")).font(.caption).foregroundStyle(.secondary) }
              }
              Spacer(minLength: 0)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(16).modifier(AccountPanel())
          }.buttonStyle(.plain)
        }
        Button { addingAddress = true } label: {
          Label(t("Add delivery address", "إضافة عنوان توصيل"), systemImage: "plus")
            .frame(maxWidth: .infinity, minHeight: 32)
        }.buttonStyle(.storefrontPrimary).controlSize(.large)
      } else if screen == "order" || screen == "notification-order" {
        if shopping.customer != nil, let detail = shopping.detail { orderDetail(detail) }
        else if !shopping.busy { Text(t("No order details to show.", "لا توجد تفاصيل طلب لعرضها.")) }
        if shopping.session.orders.detailFailed, let id = shopping.session.orders.selectedID {
          Button(t("Retry", "إعادة المحاولة")) { Task { await shopping.track(id) } }
        }
      }
    } else {
      HStack {
        Text(t("My account", "حسابي")).font(.largeTitle.bold()).accessibilityAddTraits(.isHeader)
        Spacer()
        Button { preferenceScreen = "notifications" } label: {
          Image(systemName: "bell").font(.title2).frame(width: 44, height: 44).modifier(AccountPanel())
        }.buttonStyle(.plain).accessibilityLabel(t("Notifications", "الإشعارات")).accessibilityIdentifier("account-notifications")
      }
      if let customer = shopping.customer { account(customer) }
      else {
        AccountGuestHeader(locale: locale, wishlistEnabled: wishlistEnabled,
          signIn: { switchMode("login"); preferenceScreen = "auth" },
          register: { switchMode("register"); preferenceScreen = "auth" })
      }
      Button(t("Account deletion", "حذف الحساب"), role: .destructive) { preferenceScreen = "deletion" }
        .frame(minHeight: 44).accessibilityIdentifier("account-deletion")
      AccountPreferences(locale: locale, language: { preferenceScreen = "language" },
        notifications: { preferenceScreen = "notifications" }, settings: { preferenceScreen = "settings" },
        help: openHelp, signOut: shopping.customer == nil ? nil : { Task { await shopping.logout() } })
    }
  }
  private func openOrder(_ id: String) {
    shopping.detail = nil
    preferenceScreen = "order"
    Task { await shopping.track(id) }
  }
  private var emptyOrders: some View {
    VStack(alignment: .leading, spacing: 8) {
      Label(t("No orders yet", "لا توجد طلبات بعد"), systemImage: "shippingbox").font(.headline)
      Text(t("Your orders and delivery updates will appear here.", "ستظهر طلباتك وتحديثات التوصيل هنا."))
        .font(.subheadline).foregroundStyle(.secondary)
      Button(t("Explore products", "استكشف المنتجات"), action: shop).frame(minHeight: 44)
    }.frame(maxWidth: .infinity, alignment: .leading).padding(16).modifier(AccountPanel())
  }
  private func account(_ customer: CustomerAccount) -> some View {
    VStack(alignment: .leading, spacing: 20) {
      AccountIdentity(customer: customer, locale: locale)
      HStack(alignment: .top, spacing: 10) {
        AccountShortcut(title: t("Orders", "الطلبات"), subtitle: t("View all", "عرض الكل"), icon: "shippingbox", identifier: "account-orders") { preferenceScreen = "orders" }
        if wishlistEnabled {
          NavigationLink {
            ScrollView { NativeWishlistView(shopping: shopping, locale: locale, openProduct: openProduct, shop: shop).padding(20) }
              .navigationTitle(t("Wishlist", "المفضلة"))
          } label: {
            VStack(spacing: 8) {
              Image(systemName: "heart").font(.system(size: 25))
              Text(t("Wishlist", "المفضلة")).font(.subheadline.weight(.semibold))
              Text(t("Saved items", "المحفوظات")).font(.caption).foregroundStyle(.secondary)
            }.multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
              .frame(maxWidth: .infinity, minHeight: 96).padding(.horizontal, 5).padding(.vertical, 8).modifier(AccountPanel())
          }.buttonStyle(.plain).accessibilityIdentifier("account-wishlist")
        }
        AccountShortcut(title: t("Addresses", "العناوين"), subtitle: "\(shopping.locations.count) " + t("saved", "محفوظة"), icon: "mappin.and.ellipse", identifier: "account-addresses") { preferenceScreen = "addresses" }
      }
      if !customer.verified {
        Text(t("Verify your account before checkout", "أكد حسابك قبل إتمام الطلب")).font(.headline)
        TextField(t("Verification code", "رمز التحقق"), text: $authForm.code).textContentType(.oneTimeCode).textFieldStyle(.roundedBorder)
        Button(t("Send verification code", "إرسال رمز التحقق")) { Task { await shopping.auth("request-verification", customer.identifier) } }
        Button(t("Verify", "تأكيد")) { Task { if await shopping.auth("verify", customer.identifier, code: authForm.code) { authForm.clearSecrets() } } }.buttonStyle(.storefrontPrimary)
      }
      HStack {
        Text(t("Latest order", "أحدث طلب")).font(.title3.bold())
        Spacer()
        Button(t("View all", "عرض الكل")) { preferenceScreen = "orders" }.font(.subheadline.weight(.semibold)).frame(minHeight: 44)
      }
      if let latest = shopping.orders.max(by: { $0.created_at < $1.created_at }) {
        AccountOrderCard(order: latest, locale: locale) { openOrder(latest.id) }
      } else { emptyOrders }
    }
  }
  private func orderDetail(_ detail: CustomerOrderDetail) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(t("Order", "طلب") + " #\(detail.order.number)").font(.headline).accessibilityIdentifier(
        "order-confirmation")
      Text(CommercePresentation.status(detail.order.status, locale: locale))
        .accessibilityIdentifier("order-status")
      Text(t("Ordered on", "تاريخ الطلب") + ": " + CommercePresentation.dateTime(detail.order.created_at, locale: locale))
        .font(.caption).accessibilityIdentifier("order-date")
      OrderContentsView(detail: detail, locale: locale)
      SupportControls(shopping: shopping, locale: locale, order: detail.order.id)
      ForEach(detail.history) { item in
        Text("\(CommercePresentation.status(item.status, locale: locale)) · \(CommercePresentation.dateTime(item.created_at, locale: locale))")
          .font(.caption).accessibilityIdentifier("order-history-\(item.id)")
      }
      Button(t("Refresh status", "تحديث الحالة")) { Task { await shopping.track(detail.order.id) } }
      ReorderView(order: detail.order, shopping: shopping, locale: locale).id(detail.order.id)
    }
  }
}

