package com.rocento.mobile.builder

import com.rocento.mobile.*

import java.nio.file.Files
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class StubTransport(var result: HTTPResult) : HTTPTransport {
    var url = ""
    var headers = emptyMap<String, String>()

    override suspend fun get(url: String, headers: Map<String, String>, maxBytes: Int): HTTPResult {
        this.url = url
        this.headers = headers
        return result
    }
}

class BuilderConfigTests {
    private fun data(name: String) =
        javaClass.classLoader!!.getResourceAsStream("$name.json")!!.readBytes()

    private val validator = ConfigValidator(data("schema").decodeToString())

    private fun identity(merchant: Int = 1) =
        AppBuilderIdentity(AppIdentity(
            "00000000-0000-0000-0000-00000000000$merchant",
            "staging",
            "https://merchant-$merchant.example.test/api",
        ), "https://config.example.test")

    private fun config(
        merchant: Int = 1,
        version: Int = 1,
        edit: (MutableMap<String, JsonElement>) -> Unit = {},
    ): ByteArray {
        val value =
            configJson
                .parseToJsonElement(data("merchant-$merchant").decodeToString())
                .jsonObject
                .toMutableMap()
        value["configVersion"] = JsonPrimitive(version)
        edit(value)
        return JsonObject(value).toString().toByteArray()
    }

    private fun response(bytes: ByteArray): HTTPResult {
        val h = digest(bytes)
        return HTTPResult(200, mapOf("ETag" to "\"mobile-$h\"", "X-Config-Checksum" to h), bytes)
    }

    @Test
    fun cacheNetwork304OfflineCorruptionAndTenantIsolation() = runTest {
        val dir = Files.createTempDirectory("rocento-mobile").toFile()
        try {
            val remote = response(config())
            val transport = StubTransport(remote)
            val store = ConfigStore(identity(), dir, data("merchant-1"), validator, transport)
            assertEquals("network", store.refresh("session", "ar").source)
            assertTrue(transport.url.startsWith("https://config.example.test/"))
            assertEquals("Bearer session", transport.headers["Authorization"])
            transport.result = HTTPResult(304, mapOf("etag" to remote.header("etag")!!))
            assertEquals("cache", store.refresh("session", "en").source)
            transport.result = HTTPResult(503)
            assertEquals(1, store.refresh("session", "en").config.configVersion)
            transport.result = response(config(2))
            assertEquals(identity().merchantId, store.refresh("session", "en").config.tenantId)
            transport.result = HTTPResult(200, remote.headers, remote.body + " ".toByteArray())
            assertEquals("cache", store.refresh("session", "en").source)
            val other = ConfigStore(identity(2), dir, data("merchant-2"), validator, transport)
            assertEquals("bundled", other.load().source)
            transport.result = HTTPResult(401)
            try {
                store.refresh("expired", "en")
                fail("Must expose re-enrollment")
            } catch (e: MobileFailure) {
                assertEquals("Unauthorized", e.reason)
            }
            java.io.File(dir, identity().cacheKey + ".json").writeText("broken")
            assertEquals("bundled", store.load().source)
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun restartRejectsSupersededAndChangedSnapshots() = runTest {
        val dir = Files.createTempDirectory("rocento-restart").toFile()
        try {
            val remote = response(config(version = 4))
            val transport = StubTransport(remote)
            val store = ConfigStore(identity(), dir, data("merchant-1"), validator, transport)
            assertEquals("bundled", store.refresh(null, "en").source)
            store.refresh("session", "en")
            val restarted = ConfigStore(identity(), dir, data("merchant-1"), validator, transport)
            assertEquals(4, restarted.load().config.configVersion)
            val changed =
                config(version = 4) {
                    val b = it["brand"]!!.jsonObject.toMutableMap()
                    b["displayName"] = JsonPrimitive("Changed")
                    it["brand"] = JsonObject(b)
                }
            for (bytes in listOf(config(version = 3), changed)) {
                transport.result = response(bytes)
                val snapshot = restarted.refresh("session", "en")
                assertEquals("cache", snapshot.source)
                assertEquals(4, snapshot.config.configVersion)
                assertEquals("Demo Market", snapshot.config.brand.displayName)
                assertEquals(remote.header("etag"), transport.headers["If-None-Match"])
            }
            val isolated =
                ConfigStore(
                    identity().copy(app = identity().app.copy(environment = "production")),
                    dir,
                    data("merchant-1"),
                    validator,
                    transport,
                )
            assertEquals("bundled", isolated.load().source)
        } finally {
            dir.deleteRecursively()
        }
    }

}
