import RocentoCore
import SwiftUI

struct NativeCartView: View {
  @Environment(\.storefrontButtonTheme) private var theme
  @ObservedObject var shopping: ShoppingModel
  let locale: String
  let wishlistEnabled: Bool
  let openProduct: (String) -> Void
  let shop: () -> Void
  let openSaved: () -> Void
  let openAssistant: () -> Void
  let signIn: AnyView
  private var panel: Panel? {
    get { shopping.session.navigation.cartPanel.flatMap(Panel.init(rawValue:)) }
    nonmutating set { shopping.session.navigation.openCart(newValue?.rawValue) }
  }
  @State private var summaryExpanded = false
  @State private var coupon = ""
  @State private var addingAddress = false
  private enum Panel: String, Identifiable { case checkout, coupon, saved; var id: String { rawValue } }
  private func t(_ en: String, _ ar: String) -> String { locale == "ar" ? ar : en }
  private var locked: Bool { shopping.busy || shopping.uncertainCheckout }
  private var currency: String { shopping.cart?.currency ?? "EGP" }
  private var address: String {
    if shopping.method == "pickup" {
      return shopping.availability?.methods.first { $0.type == "pickup" }?.locations?.first { $0.id == shopping.source }?.name ?? t("Choose a branch", "اختر فرعاً")
    }
    return shopping.locations.first { $0.id == shopping.selectedLocation }?.formatted_address ?? t("Choose your delivery address", "اختر عنوان التوصيل")
  }
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        deliveryCard.padding(.horizontal, 18).padding(.vertical, 12)
        if panel == nil { feedback.padding(.horizontal, 20) }
        if shopping.customer == nil {
          signIn.padding(20).disabled(shopping.busy)
        } else if let cart = shopping.cart {
          if let detail = shopping.detail, cart.items.isEmpty { confirmation(detail).padding(20) }
          if cart.items.isEmpty { emptyCart }
          else {
            Label(cart.fully_reserved ? t("Availability checked for your cart", "تم التحقق من توفر المنتجات") : t("Availability changed. Update your bag before checkout.", "تغير التوفر. حدّث الحقيبة قبل إتمام الطلب."), systemImage: cart.fully_reserved ? "checkmark.circle" : "exclamationmark.circle")
              .font(.caption).foregroundStyle(cart.fully_reserved ? theme.text.opacity(0.7) : .red)
              .padding(.horizontal, 22).padding(.vertical, 16).accessibilityIdentifier("cart-availability")
            VStack(spacing: 0) {
              ForEach(cart.items) { item in
                CartProductRow(item: item, currency: cart.currency, shopping: shopping, locale: locale,
                  wishlistEnabled: wishlistEnabled, openProduct: openProduct)
                if item.id != cart.items.last?.id { Divider() }
              }
            }.padding(.horizontal, 20).background(theme.surface)
            Button { coupon = cart.coupon_code ?? ""; panel = .coupon } label: {
              HStack(spacing: 12) {
                Image(systemName: "tag").foregroundStyle(theme.primary)
                Text(cart.coupon_code ?? t("Offers & promo codes", "العروض وأكواد الخصم")).font(.subheadline)
                SwiftUI.Spacer()
                Image(systemName: "chevron.forward").font(.caption)
              }.frame(minHeight: 54)
            }.disabled(locked).padding(.horizontal, 22).accessibilityIdentifier("cart-coupon")
            if let error = cart.coupon_error { Text(error).font(.caption).foregroundStyle(.red).padding(.horizontal, 22) }
            Divider().padding(.horizontal, 22)
            DisclosureGroup(isExpanded: $summaryExpanded) {
              VStack(spacing: 12) {
                amount(t("Subtotal", "المجموع الفرعي"), cart.subtotal)
                amount(t("Discount", "الخصم"), cart.discount_amount ?? "0", negative: true)
                Text(t("Delivery and applicable tax are confirmed at checkout.", "تُؤكّد رسوم التوصيل والضرائب المطبّقة عند إتمام الشراء."))
                  .font(.caption).foregroundStyle(theme.text.opacity(0.7)).frame(maxWidth: .infinity, alignment: .leading)
              }.padding(.top, 12)
            } label: { Text(t("Order summary", "ملخص الطلب")).font(.subheadline) }
              .padding(22).accessibilityIdentifier("cart-summary")
          }
        } else if !shopping.busy {
          Button(t("Retry loading your cart", "إعادة تحميل السلة")) { Task { await shopping.load() } }.padding(20)
        }
      }
    }.background(theme.background).foregroundStyle(theme.text)
      .safeAreaInset(edge: .bottom, spacing: 0) {
        if shopping.customer != nil && (shopping.cart?.items.isEmpty == false || shopping.uncertainCheckout) { checkoutDock }
      }
      .refreshable { await shopping.load() }
      .buttonStyle(.plain).tint(theme.primary)
      .preferredColorScheme(.light).environment(\.colorScheme, .light)
      .sheet(item: Binding(get: { panel }, set: { panel = $0 })) { selected in
        NavigationStack {
          ScrollView {
            VStack(alignment: .leading, spacing: 20) {
              feedback
              if selected == .saved { NativeWishlistView(shopping: shopping, locale: locale, openProduct: { id in panel = nil; openProduct(id) }, shop: { panel = nil; shop() }) }
              else if selected == .coupon { couponContent }
              else if let quote = shopping.quote { review(quote) }
              else { deliveryContent }
            }.padding(22)
          }.background(theme.background).foregroundStyle(theme.text)
            .navigationTitle(selected == .saved ? t("Saved for later", "محفوظ لوقت لاحق") : selected == .coupon ? t("Offers & promo codes", "العروض وأكواد الخصم") : t("Checkout", "إتمام الشراء"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(t("Done", "تم")) { panel = nil } } }
            .sheet(isPresented: $addingAddress) { AddressView(shopping: shopping, locale: locale).preferredColorScheme(.light) }
        }.tint(theme.primary).preferredColorScheme(.light).environment(\.colorScheme, .light)
          .environment(\.layoutDirection, locale == "ar" ? .rightToLeft : .leftToRight)
          .presentationDragIndicator(.visible)
      }
      .onChange(of: shopping.detail?.order.id) { _, id in if id != nil { panel = nil } }
      .onChange(of: shopping.customer?.id) { _, _ in panel = nil; coupon = "" }
  }
  @ViewBuilder private var feedback: some View {
    if shopping.busy { ProgressView().frame(maxWidth: .infinity).accessibilityLabel(t("Updating cart", "جارٍ تحديث السلة")) }
    if let error = shopping.error {
      VStack(alignment: .leading, spacing: 8) {
        Text(error).foregroundStyle(.red).accessibilityIdentifier("commerce-error")
        if panel == nil { Button(t("Retry", "إعادة المحاولة")) { Task { await shopping.load() } }.disabled(shopping.busy) }
      }.padding(.vertical, 8)
    }
  }
  private var deliveryCard: some View {
    Button { panel = .checkout } label: {
      HStack(spacing: 12) {
        Image(systemName: shopping.method == "pickup" ? "storefront" : "mappin.and.ellipse").foregroundStyle(theme.primary)
        VStack(alignment: .leading, spacing: 5) {
          Text(shopping.method == "pickup" ? t("Collect from store", "الاستلام من المتجر") : t("Deliver to", "التوصيل إلى")).font(.subheadline.weight(.semibold))
          Text(address).font(.caption).foregroundStyle(theme.text.opacity(0.7)).lineLimit(2)
          Label(shopping.asap ? t("As soon as available", "في أقرب وقت متاح") : shopping.date.formatted(.dateTime.day().month().year().locale(Locale(identifier: locale))), systemImage: "clock")
            .font(.caption).foregroundStyle(theme.text.opacity(0.7))
        }.frame(maxWidth: .infinity, alignment: .leading)
        Image(systemName: "chevron.forward").font(.caption)
      }.padding(16).background(theme.surface, in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(theme.text.opacity(0.15)))
    }.disabled(locked).accessibilityIdentifier("cart-delivery")
  }
  private var checkoutDock: some View {
    HStack(spacing: 16) {
      VStack(alignment: .leading, spacing: 4) {
        Text(t("Items total", "إجمالي المنتجات")).font(.caption)
        Text(cartMoney(shopping.cart?.itemsTotal ?? "0", currency, locale)).font(.title3.weight(.bold)).monospacedDigit().accessibilityIdentifier("cart-items-total")
      }.frame(maxWidth: .infinity, alignment: .leading)
      Button { panel = .checkout } label: {
        Text(shopping.uncertainCheckout ? t("Resolve pending order", "متابعة الطلب المعلّق") : t("Checkout", "إتمام الشراء")).font(.headline)
          .environment(\.layoutDirection, locale == "ar" ? .rightToLeft : .leftToRight)
      }.buttonStyle(.storefrontPrimary).disabled(shopping.busy || (!shopping.uncertainCheckout && shopping.cart?.fully_reserved != true))
        .accessibilityIdentifier("cart-checkout")
    }.environment(\.layoutDirection, .leftToRight)
      .padding(20).background(theme.surface).overlay(alignment: .top) { Divider() }
  }
  private var emptyCart: some View {
    VStack(spacing: 16) {
      Image(systemName: "bag").font(.system(size: 38)).foregroundStyle(theme.primary).frame(width: 96, height: 96).background(theme.primary.opacity(0.08), in: Circle())
      Text(t("Your bag is empty", "حقيبتك فارغة")).font(.title2.bold()).accessibilityIdentifier("cart-empty")
      Text(t("Fresh favourites and everyday essentials, all in one place.", "منتجاتك المفضلة واحتياجاتك اليومية، كلها في مكان واحد.")).foregroundStyle(theme.text.opacity(0.7)).multilineTextAlignment(.center)
      Button(t("Explore the store", "تصفّح المتجر"), action: shop).buttonStyle(.storefrontPrimary)
    }.frame(maxWidth: .infinity).padding(30)
  }
  private var couponContent: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text(t("Have a promo code?", "لديك كود خصم؟")).font(.title2.bold())
      TextField(t("Promo code", "كود الخصم"), text: $coupon).textInputAutocapitalization(.characters).autocorrectionDisabled()
        .textFieldStyle(.roundedBorder).accessibilityIdentifier("cart-coupon-input")
      Button(t("Apply code", "تطبيق الكود")) { Task { await shopping.applyCoupon(coupon) } }
        .buttonStyle(.storefrontPrimary).disabled(locked || coupon.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty).accessibilityIdentifier("cart-coupon-apply")
      if let error = shopping.cart?.coupon_error { Text(error).foregroundStyle(.red).accessibilityIdentifier("cart-coupon-error") }
      if let code = shopping.cart?.coupon_code {
        Label(code, systemImage: shopping.cart?.coupon_error == nil ? "checkmark.circle" : "exclamationmark.circle")
        amount(t("Discount", "الخصم"), shopping.cart?.discount_amount ?? "0", negative: true)
        Button(t("Remove code", "إزالة الكود")) { Task { await shopping.applyCoupon(""); if shopping.error == nil { coupon = "" } } }.disabled(locked)
      }
      Text(t("Eligible offers are applied by the store. Your final savings appear in the order review.", "يطبّق المتجر العروض المؤهلة، ويظهر الخصم النهائي عند مراجعة الطلب.")).font(.caption).foregroundStyle(theme.text.opacity(0.7))
    }
  }
  private var deliveryContent: some View {
    VStack(alignment: .leading, spacing: 18) {
      Text(t("Delivery your way", "التوصيل كما يناسبك")).font(.title2.bold())
      TextField(t("Gift message (optional)", "رسالة هدية (اختياري)"), text: Binding(get: { shopping.checkout.giftMessage }, set: { shopping.checkout.setGiftMessage($0) }), axis: .vertical)
        .textFieldStyle(.roundedBorder).lineLimit(3...6).accessibilityIdentifier("gift-message")
      if !shopping.checkout.giftMessageValid { Text(t("Please shorten your gift message.", "يرجى تقصير رسالة الهدية.")).foregroundStyle(.red) }
      if shopping.customer?.verified != true { Text(t("Verify your account before checkout", "أكد حسابك قبل إتمام الطلب")).foregroundStyle(.red) }
      let methods = shopping.availability?.methods ?? []
      if methods.isEmpty { Text(t("Delivery options are unavailable. Try refreshing your cart.", "خيارات التوصيل غير متاحة. جرّب تحديث السلة.")) }
      else {
        Picker(t("Fulfillment", "طريقة الاستلام"), selection: $shopping.method) {
          ForEach(methods) { method in Text(method.type == "pickup" ? t("Store pickup", "استلام من المتجر") : t("Delivery", "التوصيل")).tag(method.type) }
        }.pickerStyle(.segmented)
        if shopping.method == "pickup" {
          Picker(t("Pickup branch", "فرع الاستلام"), selection: $shopping.source) {
            Text(t("Choose a branch", "اختر فرعاً")).tag("")
            ForEach(methods.first { $0.type == "pickup" }?.locations ?? []) { Text($0.name).tag($0.id) }
          }
        } else {
          ForEach(shopping.locations) { location in
            Button { Task { await shopping.choose(location.id) } } label: {
              Label(location.formatted_address, systemImage: shopping.selectedLocation == location.id ? "checkmark.circle.fill" : "circle").frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
            }.buttonStyle(.storefrontSecondary)
          }
          Button(t("Add delivery address", "إضافة عنوان توصيل")) { addingAddress = true }.buttonStyle(.storefrontSecondary)
        }
        if let method = methods.first(where: { $0.type == shopping.method }), method.asap == true && method.scheduling {
          Toggle(t("As soon as possible", "في أقرب وقت"), isOn: $shopping.asap)
        }
        if !shopping.asap { DatePicker(t("Delivery date", "تاريخ التوصيل"), selection: $shopping.date, in: Date()..., displayedComponents: .date) }
        Button(t("Check availability", "تحقق من التوفر")) { Task { await shopping.findOptions() } }
          .buttonStyle(.storefrontSecondary).disabled(!shopping.canCheckDelivery).accessibilityIdentifier("delivery-options")
        if let options = shopping.options {
          ForEach(options.groups) { group in
            Text(group.source_name).font(.headline)
            if !shopping.asap {
              let slots = group.slots.filter { $0.availability == "AVAILABLE" }
              if slots.isEmpty { Text(t("No slots available. Choose another date.", "لا توجد مواعيد متاحة. اختر تاريخاً آخر.")).foregroundStyle(.red) }
              ForEach(slots) { slot in
                Button { shopping.windows[group.source_id] = slot } label: {
                  Label("\(CommercePresentation.dateTime(slot.starts_at, locale: locale)) – \(CommercePresentation.dateTime(slot.ends_at, locale: locale))", systemImage: shopping.windows[group.source_id]?.id == slot.id ? "checkmark.circle.fill" : "circle").frame(minHeight: 44)
                }
              }
            }
          }
          Button(t("Review order", "مراجعة الطلب")) { Task { await shopping.review() } }
            .buttonStyle(.storefrontPrimary).disabled(!shopping.canReviewCart || !shopping.checkout.giftMessageValid).accessibilityIdentifier("review-order")
        }
      }
    }.disabled(shopping.busy || shopping.uncertainCheckout)
  }
  private func review(_ quote: CommerceQuote) -> some View {
    VStack(alignment: .leading, spacing: 18) {
      Text(t("Review your order", "راجع طلبك")).font(.title2.bold())
      if let message = quote.snapshot.gift_message, !message.isEmpty { Text(t("Gift message: ", "رسالة الهدية: ") + message).accessibilityIdentifier("review-gift-message") }
      if let destination = quote.snapshot.location {
        let pickup = quote.snapshot.method == "pickup"
        Label(pickup ? t("Pickup", "استلام من الفرع") : t("Delivery", "توصيل"), systemImage: pickup ? "storefront" : "mappin.and.ellipse")
        if pickup, let name = destination.custom_label { Text(name) }
        Text(destination.formatted_address).accessibilityIdentifier("review-address")
        if let building = destination.building, !building.isEmpty { Text(t("Building: ", "المبنى: ") + building) }
        if let floor = destination.floor, !floor.isEmpty { Text(t("Floor: ", "الطابق: ") + floor) }
        if let apartment = destination.apartment, !apartment.isEmpty { Text(t("Apartment: ", "الشقة: ") + apartment) }
        if let instructions = destination.delivery_instructions, !instructions.isEmpty { Text(instructions) }
      } else {
        Text(t("Delivery details were not saved by the previous app version. Confirmation retrieves the original order without changing its destination.", "لم يحفظ الإصدار السابق تفاصيل التوصيل. يسترجع التأكيد الطلب الأصلي دون تغيير وجهته.")).font(.callout)
      }
      if let plan = quote.snapshot.fulfillment_plan {
        ForEach(plan.groups) { group in
          Text(group.source_name).font(.headline)
          if group.schedule_id != nil, let start = group.starts_at, let end = group.ends_at {
            quoteWindow(start, end, timeZone: group.timezone)
          } else { Text(t("As soon as possible", "في أقرب وقت")) }
        }
      } else if let window = quote.snapshot.scheduled_delivery, let start = window.starts_at, let end = window.ends_at {
        quoteWindow(start, end, timeZone: window.timezone)
      }
      ForEach(quote.snapshot.items ?? []) { item in
        VStack(alignment: .leading, spacing: 4) {
          Text(item.name).font(.headline)
          Text("\(item.quantity) × " + cartMoney(item.price, quote.snapshot.currency, locale))
          amount(t("Line subtotal", "المجموع الفرعي للمنتج"), item.line_total, currency: quote.snapshot.currency)
          if let discount = item.discount_amount { amount(t("Line discount", "خصم المنتج"), discount, negative: true, currency: quote.snapshot.currency) }
        }.accessibilityIdentifier("review-item-\(item.id)")
      }
      Label(quote.snapshot.payment_method == "cash_on_delivery" ? t("Cash on delivery", "الدفع عند الاستلام") : quote.snapshot.payment_method, systemImage: "banknote")
      Divider()
      amount(t("Subtotal", "المجموع الفرعي"), quote.snapshot.subtotal, currency: quote.snapshot.currency)
      amount(t("Discount", "الخصم"), quote.snapshot.discount_amount, negative: true, currency: quote.snapshot.currency)
      amount(t("Delivery", "التوصيل"), quote.snapshot.delivery_fee, currency: quote.snapshot.currency)
      amount(t("Tax", "الضريبة"), quote.snapshot.tax_amount, currency: quote.snapshot.currency)
      Divider()
      amount(t("Total", "الإجمالي"), quote.snapshot.total, currency: quote.snapshot.currency).font(.title3.bold()).accessibilityElement(children: .combine).accessibilityIdentifier("checkout-total")
      Text(t("Quote expires", "ينتهي العرض") + ": " + CommercePresentation.dateTime(quote.expires_at, locale: locale)).font(.caption).foregroundStyle(theme.text.opacity(0.7)).accessibilityIdentifier("quote-expiry")
      if shopping.uncertainCheckout { Text(t("The last result may be pending. Retry confirmation to safely retrieve the same order.", "قد تكون نتيجة الطلب معلقة. أعد التأكيد لاسترجاع نفس الطلب بأمان.")).foregroundStyle(theme.primary) }
      Button(shopping.uncertainCheckout ? t("Retry confirmation", "إعادة التأكيد") : t("Place order", "تأكيد الطلب")) { Task { await shopping.place() } }
        .buttonStyle(.storefrontPrimary).disabled(shopping.busy).accessibilityIdentifier("place-order")
      if !shopping.uncertainCheckout { Button(t("Edit delivery", "تعديل التوصيل")) { shopping.invalidateCartReview() }.disabled(shopping.busy) }
    }
  }
  private func amount(_ label: String, _ value: String, negative: Bool = false, currency: String? = nil) -> some View {
    HStack(alignment: .firstTextBaseline) { Text(label); SwiftUI.Spacer(); Text((negative ? "−" : "") + cartMoney(value, currency ?? self.currency, locale)).monospacedDigit() }
  }
  private func quoteWindow(_ start: String, _ end: String, timeZone: String?) -> some View {
    let zone = timeZone.flatMap(TimeZone.init(identifier:)) ?? .autoupdatingCurrent
    return Text(CommercePresentation.dateTime(start, locale: locale, timeZone: zone) + " – " + CommercePresentation.dateTime(end, locale: locale, timeZone: zone))
  }
  private func confirmation(_ detail: CustomerOrderDetail) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Label(t("Your order is confirmed", "تم تأكيد طلبك"), systemImage: "checkmark.circle.fill").font(.title2.bold())
      Text(t("Order", "طلب") + " #\(detail.order.number)").accessibilityIdentifier("order-confirmation")
      Text(CommercePresentation.status(detail.order.status, locale: locale)).accessibilityIdentifier("order-status")
      Text(CommercePresentation.dateTime(detail.order.created_at, locale: locale)).accessibilityIdentifier("order-date")
      ForEach(detail.history) { item in Text(CommercePresentation.status(item.status, locale: locale) + " · " + CommercePresentation.dateTime(item.created_at, locale: locale)).font(.caption).accessibilityIdentifier("order-history-\(item.id)") }
      Button(t("Refresh status", "تحديث الحالة")) { Task { await shopping.track(detail.order.id) } }.disabled(shopping.busy)
    }.padding(16).background(theme.primary.opacity(0.08), in: RoundedRectangle(cornerRadius: 18))
  }
}

private struct CartProductRow: View {
  @Environment(\.storefrontButtonTheme) private var theme
  let item: CommerceCartItem
  let currency: String
  @ObservedObject var shopping: ShoppingModel
  let locale: String
  let wishlistEnabled: Bool
  let openProduct: (String) -> Void
  @State private var product: Product?
  @Environment(\.dynamicTypeSize) private var typeSize
  private var locked: Bool { shopping.busy || shopping.uncertainCheckout }
  private func t(_ en: String, _ ar: String) -> String { locale == "ar" ? ar : en }
  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Button { openProduct(item.id) } label: {
        MerchantImage(url: product?.thumbnail.flatMap { shopping.client.imageURL($0) }).frame(width: typeSize.isAccessibilitySize ? 52 : 78, height: 88)
          .background(theme.surface, in: RoundedRectangle(cornerRadius: 14))
      }.accessibilityLabel(t("View ", "عرض ") + item.name).disabled(locked)
      VStack(alignment: .leading, spacing: 6) {
        HStack(alignment: .top) {
          Text(item.name).font(.subheadline.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
          SwiftUI.Spacer(minLength: 0)
          if wishlistEnabled {
            Button { Task { await shopping.saveCartItem(item) } } label: { Image(systemName: "bookmark").frame(width: 44, height: 44) }
              .foregroundStyle(theme.text.opacity(0.7)).accessibilityLabel(t("Save for later: ", "حفظ لوقت لاحق: ") + item.name).accessibilityIdentifier("cart-save-\(item.id)").disabled(locked)
          }
        }
        if let unit = item.unit, !unit.isEmpty { Text(unit).font(.caption).foregroundStyle(theme.text.opacity(0.7)) }
        ViewThatFits(in: .horizontal) {
          HStack { price; SwiftUI.Spacer(minLength: 8); stepper }
          VStack(alignment: .leading, spacing: 8) { price; stepper }
        }
        if item.reserved_quantity < item.quantity {
          Text(t("Only \(item.reserved_quantity) reserved. Reduce the quantity or remove this item.", "تم حجز \(item.reserved_quantity) فقط. قلّل الكمية أو احذف المنتج.")).font(.caption).foregroundStyle(.red)
        }
      }
    }.padding(.vertical, 14)
      .task(id: "\(item.id)|\(locale)|\(shopping.selectedLocation)") {
        product = nil
        // Artwork is optional. It never substitutes catalog prices for cart prices.
        product = try? await shopping.client.product(id: item.id, locale: locale)
      }
  }
  private var price: some View { Text(cartMoney(item.line_total, currency, locale)).font(.subheadline.weight(.semibold)).monospacedDigit().fixedSize() }
  private var stepper: some View {
    HStack(spacing: 0) {
      Button { Task { await shopping.quantity(item.id, item.quantity - 1) } } label: { Image(systemName: item.quantity == 1 ? "trash" : "minus").frame(width: 44, height: 44) }
        .accessibilityLabel(t("Remove one ", "حذف وحدة من ") + item.name).accessibilityIdentifier("cart-decrease-\(item.id)")
      Text(String(item.quantity)).font(.subheadline.weight(.semibold)).monospacedDigit().frame(minWidth: 22)
      Button { Task { await shopping.quantity(item.id, item.quantity + 1) } } label: { Image(systemName: "plus").frame(width: 44, height: 44) }
        .accessibilityLabel(t("Add one ", "إضافة وحدة من ") + item.name).accessibilityIdentifier("cart-increase-\(item.id)")
        .disabled(item.quantity == Int.max || item.available.map { item.quantity >= $0 } == true || item.reserved_quantity < item.quantity)
    }.background(theme.background, in: RoundedRectangle(cornerRadius: 12)).overlay(RoundedRectangle(cornerRadius: 12).stroke(theme.text.opacity(0.15))).disabled(locked)
  }
}

private func cartMoney(_ value: String, _ currency: String, _ locale: String) -> String {
  guard let number = Decimal(string: value), !number.isNaN else { return "\(value) \(currency)" }
  let formatter = NumberFormatter()
  formatter.numberStyle = .currency
  formatter.currencyCode = currency
  formatter.locale = Locale(identifier: locale == "ar" ? "ar_EG" : "en_EG")
  return formatter.string(from: NSDecimalNumber(decimal: number)) ?? "\(value) \(currency)"
}
