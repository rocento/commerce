import RocentoCore
import SwiftUI

struct OrderContentsView: View {
  let detail: CustomerOrderDetail
  let locale: String
  private func t(_ en: String, _ ar: String) -> String { locale == "ar" ? ar : en }
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      if let message = detail.order.gift_message, !message.isEmpty { Text(t("Gift message: ", "رسالة الهدية: ") + message) }
      if !(detail.items?.isEmpty ?? true) { Text(t("Your items", "منتجاتك")).font(.headline) }
      ForEach(detail.items ?? []) { item in
        VStack(alignment: .leading, spacing: 4) {
          Text(item.name).bold(); Text("\(item.quantity) × \(item.price) \(detail.order.currency)" + (item.unit.map { " · " + $0 } ?? ""))
          amount(t("Line subtotal", "المجموع الفرعي للمنتج"), item.line_total)
          amount(t("Line discount", "خصم المنتج"), item.discount_amount); Divider()
        }
      }
      amount(t("Subtotal", "المجموع الفرعي"), detail.order.subtotal)
      amount(t("Discount", "الخصم"), detail.order.discount_amount)
      amount(t("Delivery", "التوصيل"), detail.order.delivery_fee)
      amount(t("Tax", "الضريبة"), detail.order.tax_amount)
    }
  }
  @ViewBuilder private func amount(_ label: String, _ value: String?) -> some View { if let value { Text(label + ": " + value + " " + detail.order.currency) } }
}
