package com.rocento.mobile

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Test

class CustomerIdentityTests {
    @Test fun productionEmailAndMobileIdentifiers() {
        for ((kind, expected) in listOf("email" to "customer@example.test", "mobile" to "+201012345678")) {
            val value = Json.decodeFromString<CustomerAccount>("""{"id":"customer","primary_identifier":"$kind","verified":true,"email":"customer@example.test","mobile_number":"+201012345678"}""")
            assertEquals(expected, value.identifier)
        }
    }
    @Test fun missingContactNeverUsesTheIdentifierKindAsAnAddress() {
        val value = Json.decodeFromString<CustomerAccount>("""{"id":"customer","primary_identifier":"email","verified":false}""")
        assertEquals("", value.identifier)
    }
}
