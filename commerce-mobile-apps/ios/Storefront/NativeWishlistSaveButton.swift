import MapKit
import RocentoCore
import SwiftUI

struct NativeWishlistSaveButton: View {
  @ObservedObject var shopping: ShoppingModel
  let product: Product
  let locale: String
  var signIn: () -> Void
  private var saved: Bool { shopping.wishlistIDs.contains(product.id) }
  var body: some View {
    Button {
      if shopping.customer == nil { signIn() }
      else { Task { await shopping.saveProduct(product, saved: !saved) } }
    } label: {
      Label(locale == "ar" ? (saved ? "إزالة من المفضلة" : "حفظ في المفضلة") : (saved ? "Remove from wishlist" : "Save to wishlist"), systemImage: saved ? "heart.fill" : "heart")
    }.labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44).disabled(shopping.busy || shopping.uncertainCheckout).accessibilityIdentifier("save-product")
    .task {
      if shopping.customer != nil { await shopping.act { try await shopping.session.wishlist.refreshIDs() } }
    }
    if let error = shopping.error { Text(error).foregroundStyle(.red) }
  }
}

/// An in-app inbox backed by authenticated order history; it does not register for push.
