import Foundation

/// Display-only localization. API values and checkout timestamps remain unchanged.
public enum CommercePresentation {
  public enum Notice { case addedToBag, orderConfirmed }
  public static func notice(_ notice: Notice, locale: String) -> String {
    switch notice {
    case .addedToBag: return locale == "ar" ? "تمت الإضافة إلى السلة" : "Added to your bag"
    case .orderConfirmed: return locale == "ar" ? "تم تأكيد طلبك" : "Your order is confirmed"
    }
  }
  public static func money(_ amount: String, currency: String, locale: String) -> String {
    let formatter = NumberFormatter()
    formatter.numberStyle = .currency; formatter.currencyCode = currency
    formatter.locale = Locale(identifier: locale == "ar" ? "ar_EG" : "en_US")
    return formatter.string(from: NSDecimalNumber(string: amount)) ?? "\(amount) \(currency)"
  }
  public static func status(_ value: String, locale: String) -> String {
    let labels: [String: (String, String)] = [
      "placed": ("Order placed", "تم استلام الطلب"),
      "confirmed": ("Confirmed", "تم تأكيد الطلب"),
      "fulfilling": ("Preparing", "قيد التجهيز"),
      "shipped": ("Shipped", "تم الشحن"),
      "delivered": ("Delivered", "تم التوصيل"),
      "cash_collected": ("Payment collected", "تم تحصيل المبلغ"),
      "cancelled": ("Cancelled", "تم إلغاء الطلب"),
      "delivery_failed": ("Delivery failed", "تعذر التوصيل"),
      "pickup_ready": ("Ready for pickup", "جاهز للاستلام"),
      "picked_up": ("Picked up", "تم الاستلام"),
    ]
    let label = labels[value] ?? ("Status unavailable", "الحالة غير متاحة")
    return locale == "ar" ? label.1 : label.0
  }

  public static func dateTime(
    _ value: String, locale: String, timeZone: TimeZone = .autoupdatingCurrent
  ) -> String {
    let parser = ISO8601DateFormatter()
    parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let fractional = parser.date(from: value)
    parser.formatOptions = [.withInternetDateTime]
    guard let date = fractional ?? parser.date(from: value) else {
      return locale == "ar" ? "التاريخ غير متاح" : "Date unavailable"
    }
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: locale == "ar" ? "ar_EG" : "en_US")
    formatter.calendar = Calendar(identifier: .gregorian)
    formatter.timeZone = timeZone
    formatter.dateStyle = .long
    formatter.timeStyle = .short
    return formatter.string(from: date)
  }
}
