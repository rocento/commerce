import RocentoCore
import SwiftUI

/// Catalog offer presentation only; checkout continues to use the server quote.
struct ProductPriceView: View {
  let product: Product
  let locale: String
  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(CommercePresentation.money(product.displayPrice, currency: product.currency, locale: locale))
        .accessibilityIdentifier("product-offer-price")
      if product.displayPrice != product.price {
        let original = CommercePresentation.money(product.price, currency: product.currency, locale: locale)
        Text(original).font(.caption).strikethrough().foregroundStyle(.secondary)
          .accessibilityLabel((locale == "ar" ? "السعر الأصلي " : "Original price ") + original)
      }
    }
  }
}
