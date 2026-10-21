package com.rocento.mobile

import java.time.ZoneOffset
import org.junit.Assert.*
import org.junit.Test

class CommercePresentationTests {
    @Test fun everyOrderStateHasEnglishAndArabicLabels() {
        val states=listOf("placed","confirmed","fulfilling","shipped","delivered","cash_collected","cancelled","delivery_failed","pickup_ready","picked_up")
        for(state in states) {
            val english=CommercePresentation.status(state,"en")
            val arabic=CommercePresentation.status(state,"ar")
            assertNotEquals(state,english);assertFalse(english.contains('_'))
            assertNotEquals(english,arabic);assertTrue(arabic.any { it.code in 0x0600..0x06FF })
        }
        assertEquals("Delivered",CommercePresentation.status("delivered","en"))
        assertEquals("تم التوصيل",CommercePresentation.status("delivered","ar"))
    }
    @Test fun offsetAndFractionalTimestampsRepresentTheSameLocalMinute() {
        for(locale in listOf("en","ar")) {
            val expected=CommercePresentation.dateTime("2026-10-11T20:30:00Z",locale,ZoneOffset.UTC)
            assertEquals(expected,CommercePresentation.dateTime("2026-10-11T23:30:00.123456+03:00",locale,ZoneOffset.UTC))
            assertFalse(expected.contains("T20:"));assertTrue(expected.contains(if(locale=="ar")"أكتوبر" else "Oct"))
        }
    }
    @Test fun deviceTimeZoneChangesTheDayAndArabicUsesArabicDigits() {
        val value="2026-10-11T23:30:00Z"
        val english=CommercePresentation.dateTime(value,"en",ZoneOffset.ofHours(3))
        val arabic=CommercePresentation.dateTime(value,"ar",ZoneOffset.ofHours(3))
        assertTrue(english.contains("October 12, 2026"));assertTrue(arabic.contains("١٢"));assertTrue(arabic.contains("٢٠٢٦"))
        assertNotEquals(english,CommercePresentation.dateTime(value,"en",ZoneOffset.UTC))
    }
    @Test fun unknownValuesHaveLocalizedFallbacks() {
        assertEquals("Status unavailable",CommercePresentation.status("future_status","en"))
        assertEquals("الحالة غير متاحة",CommercePresentation.status("future_status","ar"))
        assertEquals("Date unavailable",CommercePresentation.dateTime("invalid","en"))
        assertEquals("التاريخ غير متاح",CommercePresentation.dateTime("","ar"))
    }
}
