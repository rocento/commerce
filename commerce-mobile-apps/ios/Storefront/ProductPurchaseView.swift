import MapKit
import RocentoCore
import SwiftUI

struct ProductPurchaseView: View {
  @ObservedObject var shopping: ShoppingModel
  let product: Product
  let locale: String
  var showsDraftQuantity = true
  var ready = true
  let signIn: () -> Void
  @State private var draftQuantity = 1
  private var quantity: Int { shopping.cart?.items.first { $0.product_id == product.id }?.quantity ?? 0 }
  private var hasAddress: Bool { !shopping.selectedLocation.isEmpty }
  private func t(_ en: String, _ ar: String) -> String { locale == "ar" ? ar : en }
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      if let error = shopping.error { Text(error).foregroundStyle(.red).font(.callout) }
      if let notice = shopping.notice { Text(notice).font(.callout).accessibilityIdentifier("commerce-notice") }
      HStack(spacing: 16) {
        VStack(alignment: .leading, spacing: 4) {
          Text(t("Price per item", "سعر القطعة")).font(.caption).foregroundStyle(.secondary)
          ProductPriceView(product: product, locale: locale).font(.headline)
        }
        Spacer(minLength: 8)
        if quantity > 0 || showsDraftQuantity { HStack(spacing: 8) {
          Button { if quantity == 0 { draftQuantity = max(1, draftQuantity - 1) } else { Task { await shopping.quantity(product.id, quantity - 1) } } } label: { Image(systemName: "minus").frame(width: 44, height: 44) }
            .disabled(shopping.uncertainCheckout || shopping.busy).accessibilityLabel(t("Decrease quantity", "تقليل الكمية"))
          Text("\(quantity == 0 ? draftQuantity : quantity)").monospacedDigit().frame(minWidth: 24).accessibilityIdentifier("product-quantity")
          Button { if quantity == 0 { draftQuantity = min(99, draftQuantity + 1) } else { Task { await shopping.quantity(product.id, quantity + 1) } } } label: { Image(systemName: "plus").frame(width: 44, height: 44) }
            .disabled((quantity == 0 ? draftQuantity : quantity) >= 99 || shopping.busy || shopping.uncertainCheckout || (hasAddress && ready && !product.inStock)).accessibilityLabel(t("Increase quantity", "زيادة الكمية"))
        }.overlay(RoundedRectangle(cornerRadius: 8).stroke(.primary.opacity(0.15))) }
      }
      if quantity == 0 { Button {
        if !hasAddress || shopping.customer == nil { signIn() } else if ready { Task { await shopping.add(product.id, quantity: draftQuantity) } }
      } label: { Text(!hasAddress ? t("Add to cart", "إضافة إلى السلة") : !ready ? t("Select an option above", "اختر أحد الخيارات أعلاه") : product.inStock ? t("Add to cart", "إضافة إلى السلة") : t("Out of stock", "غير متوفر")).font(.headline).frame(maxWidth: .infinity) }
        .buttonStyle(.storefrontPrimary).disabled(shopping.busy || (hasAddress && (!ready || !product.inStock)) || shopping.uncertainCheckout)
        .accessibilityIdentifier("add-to-bag") }
    }
  }
}

