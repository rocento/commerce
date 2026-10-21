import SwiftUI
import RocentoCore

struct ReorderView: View {
  let order: CustomerOrder
  @ObservedObject var shopping: ShoppingModel
  let locale: String
  @State private var location = ""
  @State private var replace = false
  @State private var alternative = ""
  @State private var query = ""
  @State private var products: [Product] = []
  private var store: ReorderStore { shopping.session.reorder }
  private var locked: Bool { shopping.busy || shopping.uncertainCheckout || store.busy }
  private func t(_ en: String, _ ar: String) -> String { locale == "ar" ? ar : en }
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      if store.order?.id != order.id || store.task == nil {
        Button(t("Reorder", "إعادة الطلب")) { Task { await shopping.act { try await store.start(order) } } }.accessibilityIdentifier("reorder-start")
      } else {
        Text(t("Reorder", "إعادة الطلب") + " #\(order.number)").font(.title2.bold())
        if store.done { completed }
        else if let p = store.proposal { review(p) }
        else { preparation }
        Button(t("Reload reorder", "إعادة تحميل إعادة الطلب")) { Task { await shopping.act { try await store.start(order) } } }
      }
    }.disabled(locked)
  }
  private var preparation: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(t("Current basket", "السلة الحالية")).font(.headline)
      ForEach(store.cart?.items ?? []) { item in Text("\(item.quantity) × \(item.name) · \(item.line_total) \(store.cart?.currency ?? "")") }
      if !(store.cart?.items.isEmpty ?? true) { Toggle(t("Empty the current cart before rebuilding this order", "إفراغ السلة الحالية قبل إعادة هذا الطلب"), isOn: $replace) }
      Text(t("Confirm delivery address", "تأكيد عنوان التوصيل")).font(.headline)
      ForEach(store.locations) { address in
        Button { location = address.id } label: { Label(address.formatted_address, systemImage: location == address.id ? "checkmark.circle.fill" : "circle") }
      }
      if store.locations.isEmpty { Text(t("Add a saved address in your account, then reload.", "أضف عنواناً محفوظاً في الحساب ثم أعد التحميل.")) }
      Button(replace ? t("Empty cart & review reorder", "إفراغ السلة ومراجعة إعادة الطلب") : t("Keep cart & review reorder", "الاحتفاظ بالسلة ومراجعة إعادة الطلب")) {
        Task { await shopping.act { try await store.prepare(location: location, replace: replace) } }
      }.buttonStyle(.storefrontPrimary).disabled(!store.locations.contains { $0.id == location }).accessibilityIdentifier("reorder-review")
    }
  }
  private var completed: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(t("Your reorder cart is ready", "سلة إعادة الطلب جاهزة"))
      Button(t("Continue to checkout", "متابعة لإتمام الشراء")) {
        Task { await shopping.act {
          try await shopping.session.delivery.refresh(client: shopping.client)
          if let id = store.proposal?["draft"]["location_id"].string { try await shopping.session.delivery.choose(id, client: shopping.client) }
          shopping.session.navigation.selectTab("cart"); shopping.session.navigation.presentCheckout(true)
        } }
      }.buttonStyle(.storefrontPrimary)
      Button(t("Start another reorder", "بدء إعادة طلب أخرى")) { Task { await shopping.act { try await store.start(order, again: true) } } }
    }
  }
  private func review(_ p: AssistantJSON) -> some View {
    let selections = p["draft"]["selections"].array
    return VStack(alignment: .leading, spacing: 12) {
      Text(t("Review proposed basket", "مراجعة السلة المقترحة")).font(.headline)
      ForEach(Array(p["lines"].array.enumerated()), id: \.offset) { _, line in
        let id = line["selection"]["product_id"].string ?? ""
        let quantity = line["selection"]["quantity"].integer
        Text(line["product"]["name"].string ?? t("Unavailable product", "منتج غير متوفر"))
        if let price = line["historical_price"].string { Text(t("Previous unit price: ", "سعر الوحدة السابق: ") + price).font(.caption) }
        Stepper(t("Quantity", "الكمية") + ": \(quantity)", value: Binding(get: { quantity }, set: { value in
          revise(selections.map { selection in
            guard selection["product_id"].string == id, case .object(var fields) = selection else { return selection }
            fields["quantity"] = .number(Double(value)); return .object(fields)
          })
        }), in: 1...1_000_000).disabled(store.pending)
        HStack {
          Button(t("Remove", "إزالة")) { revise(selections.filter { $0["product_id"].string != id }) }.disabled(store.pending || selections.count < 2)
          Button(t("Choose replacement", "اختيار بديل")) { alternative = id; query = ""; products = [] }.disabled(store.pending)
        }
      }
      if !alternative.isEmpty { alternatives(selections) }
      Text(t("Basket after approval", "السلة بعد الموافقة")).font(.headline)
      ForEach(Array(p["resulting_items"].array.enumerated()), id: \.offset) { _, item in Text("\(item["quantity"].integer) × \(item["name"].string ?? "") · \(item["line_total"].string ?? "") \(item["currency"].string ?? "")") }
      Text(t("Quoted total: ", "الإجمالي المعروض: ") + (p["after"]["payable"].string ?? t("Not yet verified", "لم يتم التحقق بعد")) + " " + (p["after"]["currency"].string ?? ""))
      ForEach(Array((p["issues"].array + p["notes"].array).enumerated()), id: \.offset) { _, note in Text(note.string ?? "").font(.caption) }
      Text(t("Approval updates your cart. Confirm the order separately at checkout.", "الموافقة تعدّل السلة. أكّد الطلب بشكل منفصل عند إتمام الشراء.")).font(.caption)
      Button(store.pending ? t("Check & retry basket update", "التحقق وإعادة محاولة تحديث السلة") : t("Approve & apply to bag", "الموافقة والتطبيق على السلة")) { Task { await shopping.act { try await store.approve() } } }
        .buttonStyle(.storefrontPrimary).disabled(!store.pending && !p["can_apply"].bool).accessibilityIdentifier("reorder-approve")
      Button(t("Refresh quote", "تحديث العرض")) { revise(selections) }
    }
  }
  private func alternatives(_ selections: [AssistantJSON]) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      TextField(t("Search replacement", "البحث عن بديل"), text: $query).textFieldStyle(.roundedBorder)
      Button(t("Search", "بحث")) { Task { await shopping.act {
        products = try await shopping.client.assistantProducts(query, locale: locale).filter { $0.inStock && $0.productType != "configurable" }
      } } }.disabled(query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      ForEach(products.filter { product in !selections.contains { $0["product_id"].string == product.id } }) { product in
        Button(product.name + " · " + product.price + " " + product.currency) {
          let replacement: AssistantJSON = .object(["product_id": .string(product.id), "quantity": .number(1), "replaces": .null, "required_attributes": .object([:]), "reason": .string("Customer selected replacement")])
          revise(selections.filter { $0["product_id"].string != alternative } + [replacement]); alternative = ""
        }.disabled(store.pending)
      }
    }
  }
  private func revise(_ selections: [AssistantJSON]) { Task { await shopping.act { try await store.revise(selections) } } }
}
