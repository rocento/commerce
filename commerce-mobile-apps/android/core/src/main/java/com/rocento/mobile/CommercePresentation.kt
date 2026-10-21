package com.rocento.mobile

import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.DecimalStyle
import java.time.format.FormatStyle
import java.util.Locale

/** Display-only localization; API values and checkout timestamps remain unchanged. */
object CommercePresentation {
    private val statuses = mapOf(
        "placed" to ("Order placed" to "تم استلام الطلب"),
        "confirmed" to ("Confirmed" to "تم تأكيد الطلب"),
        "fulfilling" to ("Preparing" to "قيد التجهيز"),
        "shipped" to ("Shipped" to "تم الشحن"),
        "delivered" to ("Delivered" to "تم التوصيل"),
        "cash_collected" to ("Payment collected" to "تم تحصيل المبلغ"),
        "cancelled" to ("Cancelled" to "تم إلغاء الطلب"),
        "delivery_failed" to ("Delivery failed" to "تعذر التوصيل"),
        "pickup_ready" to ("Ready for pickup" to "جاهز للاستلام"),
        "picked_up" to ("Picked up" to "تم الاستلام"),
    )
    fun status(value: String, locale: String): String {
        val label = statuses[value] ?: ("Status unavailable" to "الحالة غير متاحة")
        return if(locale == "ar") label.second else label.first
    }
    fun dateTime(value: String, locale: String, zone: ZoneId = ZoneId.systemDefault()): String {
        val language = Locale.forLanguageTag(if(locale == "ar") "ar-EG" else "en-US")
        return try {
            DateTimeFormatter.ofLocalizedDateTime(FormatStyle.LONG, FormatStyle.SHORT)
                .withLocale(language).withDecimalStyle(DecimalStyle.of(language))
                .format(OffsetDateTime.parse(value).atZoneSameInstant(zone))
        } catch (_: java.time.DateTimeException) {
            if(locale == "ar") "التاريخ غير متاح" else "Date unavailable"
        }
    }
}
