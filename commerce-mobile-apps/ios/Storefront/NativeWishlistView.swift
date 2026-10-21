import MapKit
import RocentoCore
import SwiftUI

struct NativeWishlistView: View {
  @ObservedObject var shopping: ShoppingModel
  let locale: String
  var openProduct: (String) -> Void
  var shop: () -> Void
  private func t(_ en: String, _ ar: String) -> String { locale == "ar" ? ar : en }
  var body: some View {
    Group {
      VStack(alignment: .leading, spacing: 16) {
        Text(t("Saved products", "المنتجات المحفوظة")).font(.title2.bold())
        if shopping.busy { ProgressView().accessibilityLabel(t("Loading saved products", "جارٍ تحميل المنتجات المحفوظة")) }
        if let error = shopping.error { Text(error).foregroundStyle(.red); Button(t("Retry", "إعادة المحاولة")) { Task { await shopping.loadWishlist(locale) } } }
        if shopping.wishlistLoaded && shopping.wishlistIDs.isEmpty {
          Text(t("Your wishlist is empty. Save a product from its details.", "المفضلة فارغة. احفظ منتجاً من صفحة تفاصيله."))
          Button(t("Explore products", "استكشف المنتجات"), action: shop)
        }
        if !shopping.wishlistIDs.isEmpty { Text("\(shopping.wishlistIDs.count) " + t("saved products", "منتجات محفوظة")).font(.subheadline) }
        ForEach(shopping.wishlistIDs.filter { shopping.wishlistResolved.contains($0) }, id: \.self) { id in
          VStack(alignment: .leading, spacing: 12) {
            if let product = shopping.wishlistProducts[id] {
              Button { openProduct(id) } label: {
                HStack(spacing: 12) {
                  MerchantImage(url: product.mediaIDs?.first.flatMap { shopping.client.imageURL($0) }).frame(width: 80, height: 80).clipped()
                  VStack(alignment: .leading, spacing: 8) { Text(product.title(locale)).font(.headline); Text("\(product.price) \(product.currency)").font(.subheadline) }
                }.frame(maxWidth: .infinity, alignment: .leading)
              }.buttonStyle(.plain).accessibilityIdentifier("saved-product-\(id)")
              Text(product.inStock ? t("In stock", "متوفر") : t("Out of stock", "غير متوفر")).font(.subheadline)
              Button(t("View product", "عرض المنتج")) { openProduct(id) }
            } else { Text(t("Product unavailable", "المنتج غير متاح")) }
            Button(t("Remove from wishlist", "إزالة من المفضلة")) { Task { await shopping.removeSavedProduct(id) } }.accessibilityIdentifier("remove-saved-\(id)")
            Divider()
          }
        }
        if shopping.wishlistIDs.count > shopping.wishlistResolved.count { Button(t("Load more products", "عرض المزيد من المنتجات")) { Task { await shopping.loadWishlist(locale, more: true) } } }
      }.frame(maxWidth: .infinity, alignment: .leading).disabled(shopping.busy)
    }.task(id: locale + (shopping.customer?.id ?? "")) {
      await shopping.loadWishlist(locale)
    }.refreshable { await shopping.loadWishlist(locale) }
  }
}
extension ShoppingModel {
  func removeSavedProduct(_ id: String) async {
    await act { try await session.wishlist.save(id, saved: false) }
  }
}
