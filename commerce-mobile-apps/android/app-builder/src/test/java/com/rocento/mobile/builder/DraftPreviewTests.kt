package com.rocento.mobile.builder

import com.rocento.mobile.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

class DraftPreviewTests {
    private val sid = "11111111-1111-4111-8111-111111111111"
    private fun data(name: String) = javaClass.classLoader!!.getResourceAsStream("$name.json")!!.readBytes()
    private val bytes = data("merchant-1")
    private val identity = AppBuilderIdentity(AppIdentity("00000000-0000-0000-0000-000000000001", "staging", "https://shop.example.test/api"), "https://builder.example.test/api")
    private inner class Transport : HTTPTransport {
        var response = HTTPResult(200, mapOf("x-preview-session" to sid, "x-preview-revision" to "3", "x-config-checksum" to digest(bytes)), bytes)
        var cancelled = false
        var artwork: ByteArray? = null
        val requests = mutableListOf<String>()
        override suspend fun get(url: String, headers: Map<String,String>, maxBytes: Int): HTTPResult {
            if (cancelled) throw CancellationException()
            assertEquals("Bearer " + "a".repeat(64), headers["Authorization"])
            requests.add(url)
            return if (url.contains("/assets/")) artwork?.let { HTTPResult(200, mapOf("x-asset-checksum" to digest(it)), it) } ?: HTTPResult(404) else response
        }
        override suspend fun request(url: String, method: String, headers: Map<String,String>, body: String?, maxBytes: Int): HTTPResult {
            requests.add(url)
            assertEquals("POST", method)
            assertTrue(body!!.contains("\"revision\":3"))
            return HTTPResult(200)
        }
    }
    @Test fun authenticatesChecksIntegrityAndAcknowledgesOnlyAppliedSnapshots() = runTest {
        val transport = Transport()
        val preview = DraftPreviewConfiguration(identity, "$sid.${"a".repeat(64)}", bytes, ConfigValidator(data("schema").decodeToString()), transport)
        preview.render("en") { snapshot ->
            assertEquals("draft", snapshot.source)
            assertFalse(transport.requests.any { it.contains("/ack") })
        }
        assertTrue(transport.requests.last().contains("/ack?merchantId="))
        transport.requests.clear()
        transport.response = transport.response.copy(body = bytes + byteArrayOf(32))
        preview.render("en") { fail("Invalid snapshot applied") }
        assertEquals(1, transport.requests.size) // No assets or ACK after an invalid response.
        transport.response = HTTPResult(401)
        preview.render("en") { fail("Invalid snapshot applied") }
        assertFalse(transport.requests.any { it.contains("/ack") })
    }
    @Test fun unchangedPollReusesVerifiedArtwork() = runTest {
        val transport = Transport().apply { artwork = byteArrayOf(1, 2, 3) }
        val preview = DraftPreviewConfiguration(identity, "$sid.${"a".repeat(64)}", bytes, ConfigValidator(data("schema").decodeToString()), transport)
        preview.render("en") { assertTrue(it.assets.isNotEmpty()) }
        assertTrue(transport.requests.any { it.contains("/assets/") })
        transport.requests.clear()
        preview.render("en") { assertTrue(it.assets.isNotEmpty()) }
        assertFalse(transport.requests.any { it.contains("/assets/") })
        assertTrue(transport.requests.last().contains("/ack?"))
    }
    @Test fun cancellationPropagates() = runTest {
        val transport = Transport().apply { cancelled = true }
        val preview = DraftPreviewConfiguration(identity, "$sid.${"a".repeat(64)}", bytes, ConfigValidator(data("schema").decodeToString()), transport)
        try { preview.render("en") {}; fail("Cancellation swallowed") } catch (_: CancellationException) {}
    }
}
