import RocentoCore
import SwiftUI

struct ComparisonControls: View {
  @ObservedObject var shopping: ShoppingModel
  var product: String? = nil
  let locale: String
  let openProduct: (String) -> Void
  let openAssistant: () -> Void
  @State private var presented = false
  @State private var destination: String?
  @State private var ask = false
  private var store: ComparisonStore { shopping.session.comparison }
  private func t(_ en: String, _ ar: String) -> String { locale == "ar" ? ar : en }
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      if let product {
        HStack {
          Button { store.toggle(product) } label: {
            Image(systemName: store.ids.contains(product) ? "checkmark.square.fill" : "square.split.2x1").frame(width: 44, height: 44)
          }.accessibilityLabel(t("Compare this product", "مقارنة هذا المنتج"))
            .accessibilityValue(store.ids.contains(product) ? t("Selected", "محدد") : t("Not selected", "غير محدد"))
            .disabled(!store.ids.contains(product) && store.ids.count >= 5)
          if !store.ids.isEmpty {
            Button { presented = true } label: { Image(systemName: "arrow.left.arrow.right").frame(width: 44, height: 44) }
              .accessibilityLabel(t("Compare products", "مقارنة المنتجات") + " (\(store.ids.count)/5)")
          }
        }
      } else {
        Button(t("Compare products", "مقارنة المنتجات") + " (\(store.ids.count)/5)") { presented = true }
      }
    }.disabled(shopping.busy || shopping.uncertainCheckout)
      .fullScreenCover(isPresented: $presented, onDismiss: {
        if let id = destination { destination = nil; openProduct(id) }
        if ask { ask = false; openAssistant() }
      }) {
        NavigationStack {
          ScrollView { ComparisonContent(shopping: shopping, locale: locale, open: { destination = $0; presented = false }, assistant: { shopping.assistant.draft = store.prompt; ask = true; presented = false }).padding(20) }
            .navigationTitle(t("Compare products", "مقارنة المنتجات"))
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(t("Done", "تم")) { presented = false } } }
        }
      }
  }
}
private struct ComparisonContent: View {
  @ObservedObject var shopping: ShoppingModel
  let locale: String
  let open: (String) -> Void
  let assistant: () -> Void
  @State private var ready = ""
  private var store: ComparisonStore { shopping.session.comparison }
  private var key: String { store.ids.joined(separator: ",") + locale + shopping.selectedLocation + String(describing: shopping.session.delivery.state.guestPin) + (shopping.customer?.id ?? "guest") + shopping.locations.map { "\($0.latitude),\($0.longitude)" }.joined(separator: ";") }
  private func t(_ en: String, _ ar: String) -> String { locale == "ar" ? ar : en }
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      ForEach(Array(store.ids.enumerated()), id: \.element) { index, id in
        Button(t("Remove ", "إزالة ") + (store.products.first { $0.id == id }?.name ?? "\(index + 1)")) { store.toggle(id) }
      }
      if !store.ids.isEmpty { Button(t("Clear all", "مسح الكل")) { store.reset() } }
      if store.ids.count < 2 { Text(t("Select at least two products to compare", "اختر منتجين على الأقل للمقارنة")) }
      if store.busy { ProgressView() }
      if !store.failed.isEmpty {
        Text(t("A selected product is unavailable. Remove it or retry.", "أحد المنتجات غير متوفر. احذفه أو أعد المحاولة."))
        Button(t("Retry", "إعادة المحاولة")) { Task { await load() } }.disabled(store.busy)
      }
      if ready == key && !store.busy && store.failed.isEmpty && store.products.count >= 2 {
        ScrollView(.horizontal) {
          VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 0) {
              Text(t("Detail", "التفاصيل")).frame(width: 156, alignment: .leading).padding(12)
              ForEach(store.products) { p in
                VStack(alignment: .leading) {
                  MerchantImage(url: p.media_ids?.first.flatMap { shopping.client.imageURL($0) }).frame(width: 100, height: 100).accessibilityHidden(true)
                  Button(p.name) { open(p.id) }
                }.frame(width: 156, alignment: .leading).padding(12)
              }
            }
            ForEach(Array(store.rows(locale: locale).enumerated()), id: \.offset) { _, row in
              HStack(alignment: .top, spacing: 0) {
                Text(row.label).bold().frame(width: 156, alignment: .leading).padding(12)
                ForEach(Array(row.values.enumerated()), id: \.offset) { _, value in Text(value).frame(width: 156, alignment: .leading).padding(12) }
              }; Divider()
            }
          }
        }
        Text(t("Currencies are not converted. Availability depends on delivery location.", "لا يتم تحويل العملات. يعتمد التوفر على موقع التوصيل.")).font(.caption)
        Button(t("Ask the shopping assistant", "اسأل مساعد التسوق"), action: assistant).buttonStyle(.storefrontPrimary)
      }
    }.disabled(shopping.busy || shopping.uncertainCheckout).task(id: key) { await load() }
  }
  private func load() async { let expected = key; await store.load { try await shopping.client.comparisonProduct($0, locale: locale) }; if !Task.isCancelled { ready = expected } }
}
