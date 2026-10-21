package com.rocento.mobile

import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

class StandaloneTests {
    private fun bytes(name: String) = javaClass.classLoader!!.getResourceAsStream("$name.json")!!.readBytes()
    private val identity = AppIdentity("00000000-0000-0000-0000-000000000001", "production", "https://shop.example.test/api")
    private val validator = ConfigValidator(bytes("schema").decodeToString())

    @Test fun bundledDesignAndLocalAssetsSurviveRefreshAndRestartWithoutServices() = runTest {
        repeat(2) {
            val provider = BundledConfiguration(identity, bytes("merchant-1"), validator, mapOf("logo" to byteArrayOf(1, 2, 3)))
            for (locale in listOf("en", "ar")) {
                val result = provider.refresh(locale)
                assertEquals("bundled", result.source)
                assertEquals(0, result.config.configVersion)
                assertEquals(locale, result.config.locale(locale))
                assertArrayEquals(byteArrayOf(1, 2, 3), result.assets["logo"])
            }
        }
        assertNotEquals(identity.cacheKey, identity.copy(commerceBase = "https://another.example.test/api").cacheKey)
    }
    @Test fun standaloneStillRejectsWrongMerchantAndUnsafeCommerceOrigin() {
        assertThrows(Exception::class.java) { BundledConfiguration(identity, bytes("merchant-2"), validator) }
        assertThrows(Exception::class.java) { identity.copy(commerceBase = "http://shop.example.test/api") }
    }
}
