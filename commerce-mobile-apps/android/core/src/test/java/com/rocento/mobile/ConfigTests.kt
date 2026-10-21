package com.rocento.mobile

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

class ConfigTests {
    private fun data(name: String) =
        javaClass.classLoader!!.getResourceAsStream("$name.json")!!.readBytes()

    private val validator = ConfigValidator(data("schema").decodeToString())

    private fun identity(merchant: Int = 1) =
        AppIdentity(
            "00000000-0000-0000-0000-00000000000$merchant",
            "staging",
            "https://merchant-$merchant.example.test/api",
        )

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
    fun dealsRequireRuntime12() {
        for (iconsOnly in listOf(false, true)) {
            fun bytes(minimum: String) = config { value ->
                value["navigation"] = JsonObject(value.getValue("navigation").jsonObject.toMutableMap().apply {
                    if (iconsOnly) put("icons", buildJsonObject { put("home", "deals") })
                    else put("tabs", JsonArray(listOf("home", "categories", "deals", "account", "cart").map(::JsonPrimitive)))
                })
                value["compatibility"] = buildJsonObject { put("minIosRuntime", minimum); put("minAndroidRuntime", minimum) }
            }
            assertThrows(Exception::class.java) { validator.decode(bytes("1.1.0"), identity()) }
            assertThrows(Exception::class.java) { validator.decode(bytes("1.1.0"), identity().copy(runtime = "1.1.0")) }
            assertThrows(Exception::class.java) { validator.decode(bytes("1.2.0"), identity().copy(runtime = "1.1.0")) }
            validator.decode(bytes("1.2.0"), identity())
        }
    }

    @Test
    fun configuredIconsAndLegacyDefaults() {
        assertNull(validator.decode(config(), identity()).navigation.icons)
        val bytes = config { value ->
            value["navigation"] = JsonObject(value.getValue("navigation").jsonObject.toMutableMap().apply {
                put("icons", buildJsonObject { put("home", "location"); put("cart", "wishlist") })
            })
            value["compatibility"] = buildJsonObject {
                put("minIosRuntime", "1.1.0"); put("minAndroidRuntime", "1.1.0")
            }
        }
        val updated = validator.decode(bytes, identity())
        assertEquals("location", updated.navigation.icons?.get("home")?.name)
        assertEquals("wishlist", updated.navigation.icons?.get("cart")?.name)
        assertThrows(Exception::class.java) { validator.decode(bytes, identity().copy(runtime = "1.0.0")) }
    }

    @Test
    fun bothFixturesAndRTL() {
        for (i in listOf(1, 2)) {
            val c = validator.decode(data("merchant-$i"), identity(i), true)
            assertEquals("ar", c.locale("ar"))
            assertEquals("منتجات مميزة", c.text("featured_title", "ar"))
            assertEquals(2, c.screens.home.sections.size)
        }
    }

    @Test
    fun closedSchemaTenantAndCompatibility() {
        assertThrows(Exception::class.java) { validator.decode(config(2), identity()) }
        assertThrows(Exception::class.java) { validator.decode(config(version = 0), identity()) }
        val bad =
            listOf<(MutableMap<String, JsonElement>) -> Unit>(
                { it["javascript"] = JsonPrimitive("alert(1)") },
                {
                    it["compatibility"] = buildJsonObject {
                        put("minIosRuntime", "1.0.0")
                        put("minAndroidRuntime", "2.0.0")
                    }
                },
                {
                    it["screens"] =
                        configJson.parseToJsonElement(
                            """{"home":{"sections":[{"id":"x","type":"webView","props":{}}]}}""",
                        )
                },
                {
                    val b = it["brand"]!!.jsonObject.toMutableMap()
                    val p = b["light"]!!.jsonObject.toMutableMap()
                    p["onPrimary"] = p["primary"]!!
                    b["light"] = JsonObject(p)
                    it["brand"] = JsonObject(b)
                },
            )
        for (edit in bad) assertThrows(Exception::class.java) {
            validator.decode(config(edit = edit), identity())
        }
    }

    @Test
    fun commerceIsBoundAndDoesNotSendConfigCredential() = runTest {
        val product =
            configJson
                .parseToJsonElement(data("catalog-1").decodeToString())
                .jsonObject["products"]!!
                .jsonArray
                .first()
        val transport = StubTransport(HTTPResult(200, body = product.toString().toByteArray()))
        val catalog = CommerceCatalog(identity(), transport)
        val id = product.jsonObject["id"]!!.jsonPrimitive.content
        assertEquals(id, catalog.product(id, "ar").id)
        assertTrue(transport.url.startsWith("https://merchant-1.example.test/api/"))
        assertNull(transport.headers["Authorization"])
        assertEquals("ar", transport.headers["X-Storefront-Locale"])
        try {
            catalog.product("https://evil.test", "en")
            fail("Invalid route")
        } catch (_: MobileFailure) {}
    }

    @Test
    fun transportRejectsRedirectsAndOversizedBodies() = runTest {
        okhttp3.mockwebserver.MockWebServer().use { server ->
            server.start()
            server.enqueue(
                okhttp3.mockwebserver
                    .MockResponse()
                    .setResponseCode(302)
                    .setHeader("Location", server.url("/other")),
            )
            val transport = OkHTTPTransport()
            val response =
                transport.get(
                    server.url("/config").toString(),
                    mapOf("Authorization" to "Bearer test-only"),
                    16,
                )
            assertEquals(302, response.status)
            assertEquals(1, server.requestCount)
            server.enqueue(okhttp3.mockwebserver.MockResponse().setBody("A".repeat(17)))
            try {
                transport.get(server.url("/config").toString(), emptyMap(), 16)
                fail("Must bound response size")
            } catch (e: MobileFailure) {
                assertEquals("Response too large", e.reason)
            }
        }
    }
}
