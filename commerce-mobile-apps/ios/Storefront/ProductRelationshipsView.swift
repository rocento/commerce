import RocentoCore
import SwiftUI

struct ProductRelationshipsView: View {
  @ObservedObject var shopping: ShoppingModel
  let sources: [String]
  let kind: String
  let locale: String
  let open: (String) -> Void
  @State private var products: [Product] = []
  @State private var loadedKey = ""
  @State private var failed = false
  @State private var retry = 0
  private var key: String { ([kind, locale, shopping.customer?.id ?? "guest", shopping.selectedLocation, String(describing: shopping.session.delivery.state.guestPin)] + sources.sorted() + shopping.locations.map { "\($0.id):\($0.latitude):\($0.longitude)" }).joined(separator: "|") }
  private var title: String {
    if locale == "ar" { return ["related": "منتجات ذات صلة", "upsell": "خيارات أخرى قد تعجبك", "cross_sell": "أكمل طلبك"][kind] ?? "" }
    return ["related": "Related products", "upsell": "More options to consider", "cross_sell": "Complete your order"][kind] ?? ""
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      if loadedKey == key && (failed || !products.isEmpty) {
        Text(title).font(.headline).accessibilityAddTraits(.isHeader)
        if failed { Button(locale == "ar" ? "إعادة المحاولة" : "Retry") { retry += 1 } }
        ForEach(products) { product in
          Button { open(product.id) } label: {
            VStack(alignment: .leading, spacing: 4) {
              Text(product.title(locale)); Text(product.price + " " + product.currency).font(.subheadline)
              if !product.inStock { Text(locale == "ar" ? "غير متوفر" : "Out of stock").font(.caption) }
            }.frame(maxWidth: .infinity, alignment: .leading)
          }.buttonStyle(.storefrontSecondary)
        }
      }
    }.disabled(shopping.busy || shopping.uncertainCheckout)
      .task(id: key + ":\(retry)") {
        let expected = key
        guard !sources.isEmpty, sources.count <= 50 else { return }
        do {
          let values = try await shopping.client.relationships(sources, kind: kind, locale: locale)
          try Task.checkCancellation()
          guard expected == key else { return }
          products = values; failed = false; loadedKey = expected
        } catch {
          guard !Task.isCancelled, expected == key else { return }
          products = []; failed = true; loadedKey = expected
        }
      }
  }
}
