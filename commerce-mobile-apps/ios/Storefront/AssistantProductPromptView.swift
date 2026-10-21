import RocentoCore
import SwiftUI

@MainActor private final class ProductPromptObserver: ObservableObject {
  let store = ProductPromptStore()
  init() { store.onChange = { [weak self] in self?.objectWillChange.send() } }
}
struct AssistantProductPromptView: View {
  let prompt: AssistantJSON
  @ObservedObject var shopping: ShoppingModel
  let locale: String
  let locked: Bool
  let openProduct: (String) -> Void
  let send: (String, String?) -> Void
  @StateObject private var model = ProductPromptObserver()
  private var products: [Product] { model.store.products }
  private var selected: Set<String> { model.store.selected }
  private var loading: Bool { model.store.loading }
  private var failed: Bool { model.store.failed }
  private func t(_ en: String, _ ar: String) -> String { locale == "ar" ? ar : en }
  private var query: String { prompt["query"].string ?? "" }
  private var action: String { prompt["action"].string ?? "choose" }
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(t("Choose a product: ", "اختر منتجاً: ") + query).font(.headline)
      if loading { ProgressView() }
      if failed { Button(t("Retry product search", "إعادة البحث عن المنتجات")) { Task { await load() } } }
      if !loading && !failed && products.isEmpty { Text(t("No matching products. Try another name.", "لا توجد منتجات مطابقة. جرّب اسماً آخر.")) }
      ForEach(products) { product in
        VStack(alignment: .leading, spacing: 8) {
          HStack {
            MerchantImage(url: product.thumbnail.flatMap { shopping.client.imageURL($0) }).frame(width: 64, height: 64).accessibilityHidden(true)
            VStack(alignment: .leading) { Text(product.title(locale)).font(.headline); Text("\(product.displayPrice) \(product.currency)") }
          }
          if action == "compare" {
            Toggle(t("Compare this product", "مقارنة هذا المنتج"), isOn: Binding(get: { selected.contains(product.id) }, set: { model.store.select(product.id, enabled: $0) })).disabled(locked)
          } else {
            Button(t("View product", "عرض المنتج")) { openProduct(product.id) }
            if product.productType == "simple" {
              if action == "cart" || action == "choose" { Button(t("Add to bag", "إضافة للسلة")) { choose(product, destination: "cart") }.disabled(locked || !product.inStock) }
              if action == "wishlist" || action == "choose" { Button(t("Save to wishlist", "حفظ في المفضلة")) { choose(product, destination: "wishlist") }.disabled(locked) }
              if action == "remove" { Button(t("Remove from bag", "حذف من السلة")) { send("Remove this product from cart", product.id) }.disabled(locked) }
            }
          }
        }.padding(12).background(.secondary.opacity(0.07), in: RoundedRectangle(cornerRadius: 12))
      }
      if action == "compare" {
        Button(t("Compare selected products", "مقارنة المنتجات المحددة")) { send("Compare " + products.filter { selected.contains($0.id) }.map { "/products/" + $0.id }.joined(separator: " and "), nil) }.disabled(locked || selected.count < 2 || selected.count > 5)
      }
    }.task(id: query + locale + shopping.selectedLocation) { await load() }
      .onDisappear { model.store.reset() }
  }
  private func choose(_ product: Product, destination: String) {
    let quantity = destination == "wishlist" ? 1 : min(1_000_000, max(1, prompt["quantity"].integer))
    send("Add \(quantity) of this product to \(destination)", product.id)
  }
  private func load() async {
    await model.store.load { try await shopping.client.assistantProducts(String(query.prefix(120)), locale: locale) }
  }
}
