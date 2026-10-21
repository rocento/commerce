import XCTest
@testable import RocentoCore

final class CommercePresentationTests: XCTestCase {
  func testPurchaseNoticesAreLocalized() {
    XCTAssertEqual(CommercePresentation.notice(.addedToBag, locale: "ar"), "تمت الإضافة إلى السلة")
    XCTAssertEqual(CommercePresentation.notice(.orderConfirmed, locale: "ar"), "تم تأكيد طلبك")
    XCTAssertEqual(CommercePresentation.notice(.addedToBag, locale: "en"), "Added to your bag")
  }
  func testEveryOrderStateHasEnglishAndArabicLabels() {
    let states = ["placed", "confirmed", "fulfilling", "shipped", "delivered", "cash_collected", "cancelled", "delivery_failed", "pickup_ready", "picked_up"]
    for state in states {
      let english = CommercePresentation.status(state, locale: "en")
      let arabic = CommercePresentation.status(state, locale: "ar")
      XCTAssertNotEqual(english, state)
      XCTAssertFalse(english.contains("_"))
      XCTAssertNotEqual(arabic, english)
      XCTAssertTrue(arabic.unicodeScalars.contains { (0x0600...0x06FF).contains($0.value) })
    }
    XCTAssertEqual(CommercePresentation.status("delivered", locale: "en"), "Delivered")
    XCTAssertEqual(CommercePresentation.status("delivered", locale: "ar"), "تم التوصيل")
  }
  func testOffsetAndFractionalTimestampsRepresentTheSameLocalMinute() {
    let zone = TimeZone(secondsFromGMT: 0)!
    for locale in ["en", "ar"] {
      let expected = CommercePresentation.dateTime("2026-10-11T20:30:00Z", locale: locale, timeZone: zone)
      XCTAssertEqual(expected, CommercePresentation.dateTime("2026-10-11T23:30:00.123456+03:00", locale: locale, timeZone: zone))
      XCTAssertFalse(expected.contains("T20:"))
      XCTAssertTrue(expected.contains(locale == "ar" ? "أكتوبر" : "Oct"))
    }
  }
  func testDeviceTimeZoneChangesTheDayAndArabicUsesArabicDigits() {
    let value = "2026-10-11T23:30:00Z"
    let zone = TimeZone(secondsFromGMT: 3 * 3600)!
    let english = CommercePresentation.dateTime(value, locale: "en", timeZone: zone)
    let arabic = CommercePresentation.dateTime(value, locale: "ar", timeZone: zone)
    XCTAssertTrue(english.contains("October 12, 2026"))
    XCTAssertTrue(arabic.contains("١٢"))
    XCTAssertTrue(arabic.contains("٢٠٢٦"))
    XCTAssertNotEqual(english, CommercePresentation.dateTime(value, locale: "en", timeZone: TimeZone(secondsFromGMT: 0)!))
  }
  func testUnknownValuesHaveLocalizedFallbacks() {
    XCTAssertEqual(CommercePresentation.status("future_status", locale: "en"), "Status unavailable")
    XCTAssertEqual(CommercePresentation.status("future_status", locale: "ar"), "الحالة غير متاحة")
    XCTAssertEqual(CommercePresentation.dateTime("invalid", locale: "en"), "Date unavailable")
    XCTAssertEqual(CommercePresentation.dateTime("", locale: "ar"), "التاريخ غير متاح")
  }
}
