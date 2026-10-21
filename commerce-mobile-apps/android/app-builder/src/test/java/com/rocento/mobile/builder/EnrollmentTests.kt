package com.rocento.mobile.builder

import com.rocento.mobile.*

import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

private class EnrollmentTransport(val replies: MutableList<HTTPResult>) : HTTPTransport {
    data class Call(
        val url: String,
        val method: String,
        val headers: Map<String, String>,
        val body: String?,
    )

    val calls = mutableListOf<Call>()

    override suspend fun get(url: String, headers: Map<String, String>, maxBytes: Int) =
        request(url, "GET", headers, null, maxBytes)

    override suspend fun request(
        url: String,
        method: String,
        headers: Map<String, String>,
        body: String?,
        maxBytes: Int,
    ): HTTPResult {
        calls.add(Call(url, method, headers, body))
        return replies.removeAt(0)
    }
}

class EnrollmentTests {
    private val merchant = "00000000-0000-0000-0000-000000000001"
    private val access = "a".repeat(64)
    private val device = "d".repeat(64)

    private fun identity() =
        AppBuilderIdentity(AppIdentity(
            merchant,
            "production",
            "https://shop.example.test/api",
        ), "https://config.example.test/api")

    private fun session(tenant: String = merchant, credential: String? = null) =
        HTTPResult(
            200,
            body =
                """{"deviceId":"00000000-0000-0000-0000-000000000003","accessToken":"$access","expiresIn":1800,"merchantId":"$tenant","platform":"android","identifier":"com.rocento.grocery","environment":"production","deviceToken":${credential?.let{"\"$it\""}?:"null"}}"""
                    .toByteArray(),
        )

    @Test
    fun enrollmentRenewalAndAssetCredentialBoundaries() = runTest {
        val png = byteArrayOf(1, 2, 3)
        val transport =
            EnrollmentTransport(
                mutableListOf(
                    session(credential = device),
                    HTTPResult(
                        200,
                        mapOf("content-type" to "image/png", "x-asset-checksum" to digest(png)),
                        png,
                    ),
                ),
            )
        val storage = MemoryCredential()
        val client = EnrollmentClient(identity(), "com.rocento.grocery", storage, transport)
        assertNull(client.token())
        client.enroll("c".repeat(64))
        assertEquals(device, storage.read())
        assertArrayEquals(png, client.asset("10000000-0000-0000-0000-000000000001", "ar"))
        assertNull(transport.calls[0].headers["Authorization"])
        assertEquals("POST", transport.calls[0].method)
        assertEquals("1", transport.calls[0].headers["X-Commerce-Request"])
        assertEquals("Bearer $access", transport.calls[1].headers["Authorization"])
        assertTrue(
            transport.calls.all {
                java.net.URI(it.url).host == "config.example.test" && it.headers["Cookie"] == null
            },
        )
        val renewed = EnrollmentTransport(mutableListOf(session(), HTTPResult(401)))
        val restart = EnrollmentClient(identity(), "com.rocento.grocery", storage, renewed)
        val one = async { restart.token() }
        val two = async { restart.token() }
        assertEquals(access, one.await())
        assertEquals(access, two.await())
        assertEquals(1, renewed.calls.size)
        assertTrue(renewed.calls[0].url.endsWith("/v1/mobile/session"))
        val revoked = EnrollmentClient(identity(), "com.rocento.grocery", storage, renewed)
        try {
            revoked.token()
            fail("Revoked accepted")
        } catch (e: MobileFailure) {
            assertEquals("Unauthorized", e.reason)
        }
        assertNull(storage.read())
    }

    @Test
    fun wrongMerchantAndBadAssetChecksumRejected() = runTest {
        val storage = MemoryCredential(device)
        val transport =
            EnrollmentTransport(
                mutableListOf(
                    session("00000000-0000-0000-0000-000000000002", device),
                    session(),
                    HTTPResult(
                        200,
                        mapOf("content-type" to "image/png", "x-asset-checksum" to "wrong"),
                        byteArrayOf(1),
                    ),
                ),
            )
        val client = EnrollmentClient(identity(), "com.rocento.grocery", storage, transport)
        try {
            client.enroll("c".repeat(64))
            fail("Foreign enrollment accepted")
        } catch (_: MobileFailure) {}
        assertEquals(device, storage.read())
        try {
            client.asset("10000000-0000-0000-0000-000000000001", "en")
            fail("Corrupt image accepted")
        } catch (_: MobileFailure) {}
    }

    @Test
    fun enrolledInstallationLoadsSuccessivePublicationsAndOfflineSnapshot() = runTest {
        fun data(name: String) =
            javaClass.classLoader!!.getResourceAsStream("$name.json")!!.readBytes()
        val fallback = data("merchant-1")
        fun publication(version: Int): HTTPResult {
            val config =
                configJson.parseToJsonElement(fallback.decodeToString()).jsonObject.toMutableMap()
            config["configVersion"] = JsonPrimitive(version)
            if (version == 2) {
                val brand = config.getValue("brand").jsonObject.toMutableMap()
                brand["displayName"] = JsonPrimitive("Published Rocento update")
                config["brand"] = JsonObject(brand)
            }
            val bytes = JsonObject(config).toString().toByteArray()
            val hash = digest(bytes)
            return HTTPResult(
                200,
                mapOf("etag" to "\"mobile-$hash\"", "x-config-checksum" to hash),
                bytes,
            )
        }
        val first = publication(1)
        val transport =
            EnrollmentTransport(mutableListOf(session(credential = device), first, publication(2)))
        val client =
            EnrollmentClient(identity(), "com.rocento.grocery", MemoryCredential(), transport)
        val directory = java.nio.file.Files.createTempDirectory("enrolled-config").toFile()
        try {
            val store =
                ConfigStore(
                    identity(),
                    directory,
                    fallback,
                    ConfigValidator(data("schema").decodeToString()),
                    transport,
                )
            client.enroll("c".repeat(64))
            assertEquals(1, store.refresh(client.token(), "en").config.configVersion)
            val second = store.refresh(client.token(), "ar")
            assertEquals(2, second.config.configVersion)
            assertEquals("Published Rocento update", second.config.brand.displayName)
            val offline = store.refresh(client.token(), "ar")
            assertEquals(2, offline.config.configVersion)
            assertEquals("cache", offline.source)
            assertEquals(first.header("etag"), transport.calls[2].headers["If-None-Match"])
        } finally {
            directory.deleteRecursively()
        }
    }
}
