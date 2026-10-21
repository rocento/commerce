package com.rocento.mobile.builder

import com.rocento.mobile.*
import java.nio.file.Files
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class BuilderAvailabilityTests {
    private fun bytes(name: String) = javaClass.classLoader!!.getResourceAsStream("$name.json")!!.readBytes()
    private val identity = AppBuilderIdentity(AppIdentity("00000000-0000-0000-0000-000000000001", "production", "https://shop.example.test/api"), "https://config.example.test")
    private val validator = ConfigValidator(bytes("schema").decodeToString())

    @Test fun unavailableOrRevokedBuilderReturnsBundledDesign() = runTest {
        val directory = Files.createTempDirectory("builder-unavailable").toFile()
        try {
            for (status in listOf(503, 401)) {
                val storage = MemoryCredential("d".repeat(64))
                val transport = AvailabilityTransport(session = HTTPResult(status))
                val provider = AppBuilderConfiguration(identity, "com.rocento.grocery", storage, directory, bytes("merchant-1"), validator, transport)
                val result = provider.refresh("ar")
                assertEquals("bundled", result.source)
                assertEquals(identity.merchantId, result.config.tenantId)
                assertTrue(result.assets.isEmpty())
                if (status == 401) assertNull(storage.read())
                assertEquals("Failed renewal must not be retried for artwork", 1, transport.calls.size)
            }
        } finally { directory.deleteRecursively() }
    }
    private fun publication(version: Int = 1): HTTPResult {
        val data = JsonObject(configJson.parseToJsonElement(bytes("merchant-1").decodeToString()).jsonObject +
            ("configVersion" to JsonPrimitive(version))).toString().toByteArray()
        val hash = digest(data)
        return HTTPResult(200, mapOf("etag" to "\"mobile-$hash\"", "x-config-checksum" to hash), data)
    }

    @Test fun configurationFailureUsesCacheWithoutFetchingArtwork() = runTest {
        val directory = Files.createTempDirectory("builder-config-unavailable").toFile()
        try {
            val cached = ConfigStore(identity, directory, bytes("merchant-1"), validator, StubTransport(publication(42)))
            cached.refresh("test", "en")
            for (status in listOf(503, 401)) {
                val transport = AvailabilityTransport(config = HTTPResult(status))
                val provider = AppBuilderConfiguration(identity, "com.rocento.grocery", MemoryCredential("d".repeat(64)),
                    directory, bytes("merchant-1"), validator, transport)
                val result = provider.refresh("en")
                assertEquals("cache", result.source)
                assertEquals(42, result.config.configVersion)
                assertTrue(result.assets.isEmpty())
                assertEquals("Config failure must not fan out into artwork requests", 2, transport.calls.size)
            }
        } finally { directory.deleteRecursively() }
    }

    @Test fun artworkFailureStopsFurtherRequests() = runTest {
        val directory = Files.createTempDirectory("builder-artwork-unavailable").toFile()
        try {
            val transport = AvailabilityTransport(config = publication(), asset = HTTPResult(503))
            val provider = AppBuilderConfiguration(identity, "com.rocento.grocery", MemoryCredential("d".repeat(64)),
                directory, bytes("merchant-1"), validator, transport)
            val result = provider.refresh("en")
            assertEquals("network", result.source)
            assertTrue(result.assets.isEmpty())
            assertEquals(3, transport.calls.size)
        } finally { directory.deleteRecursively() }
    }

    @Test fun unenrolledProviderUsesBundleWithoutRequests() = runTest {
        val directory = Files.createTempDirectory("builder-unenrolled").toFile()
        try {
            val transport = AvailabilityTransport()
            val provider = AppBuilderConfiguration(identity, "com.rocento.grocery", MemoryCredential(),
                directory, bytes("merchant-1"), validator, transport)
            assertEquals("bundled", provider.refresh("en").source)
            assertTrue(transport.calls.isEmpty())
        } finally { directory.deleteRecursively() }
    }

    @Test fun cancellationAtEachNetworkStagePreservesCredential() = runTest {
        for (stage in listOf("session", "config", "assets")) {
            val directory = Files.createTempDirectory("builder-cancelled").toFile()
            try {
                val transport = AvailabilityTransport(config = publication(), cancelledStage = stage)
                val storage = MemoryCredential("d".repeat(64))
                val provider = AppBuilderConfiguration(identity, "com.rocento.grocery", storage,
                    directory, bytes("merchant-1"), validator, transport)
                try {
                    provider.refresh("en")
                    fail("Cancellation must not turn into a successful fallback: $stage")
                } catch (_: CancellationException) { }
                assertEquals("d".repeat(64), storage.read())
            } finally { directory.deleteRecursively() }
        }
    }

    @Test fun notModifiedPublicationStillLoadsPrivateArtwork() = runTest {
        val directory = Files.createTempDirectory("builder-not-modified").toFile()
        try {
            val response = publication()
            val transport = AvailabilityTransport(config = response)
            val provider = AppBuilderConfiguration(identity, "com.rocento.grocery", MemoryCredential("d".repeat(64)),
                directory, bytes("merchant-1"), validator, transport)
            val first = provider.refresh("en")
            assertFalse(first.assets.isEmpty())
            transport.config = HTTPResult(304, mapOf("etag" to response.header("etag")!!))
            val second = provider.refresh("en")
            assertEquals("cache", second.source)
            assertEquals(first.assets.keys, second.assets.keys)
            first.assets.forEach { (id, data) -> assertArrayEquals(data, second.assets[id]) }
        } finally { directory.deleteRecursively() }
    }
    @Test fun standaloneIgnoresValidPreviouslyPublishedBuilderCache() = runTest {
        val directory = Files.createTempDirectory("builder-cache").toFile()
        try {
            val fallback = bytes("merchant-1")
            val data = JsonObject(configJson.parseToJsonElement(fallback.decodeToString()).jsonObject + ("configVersion" to JsonPrimitive(42))).toString().toByteArray()
            val hash = digest(data)
            val remote = ConfigStore(identity, directory, fallback, validator, StubTransport(HTTPResult(200, mapOf("etag" to "\"mobile-$hash\"", "x-config-checksum" to hash), data)))
            assertEquals(42, remote.refresh("test", "en").config.configVersion)
            val result = BundledConfiguration(identity.app, fallback, validator).refresh("en")
            assertEquals(0, result.config.configVersion)
            assertEquals("bundled", result.source)
            assertTrue(java.io.File(directory, identity.cacheKey + ".json").exists())
        } finally { directory.deleteRecursively() }
    }
}

private class AvailabilityTransport(
    val session: HTTPResult = HTTPResult(200, body = """{"deviceId":"00000000-0000-0000-0000-000000000003","accessToken":"${"a".repeat(64)}","expiresIn":1800,"merchantId":"00000000-0000-0000-0000-000000000001","platform":"android","identifier":"com.rocento.grocery","environment":"production"}""".toByteArray()),
    var config: HTTPResult = HTTPResult(503),
    val asset: HTTPResult = byteArrayOf(1, 2, 3).let {
        HTTPResult(200, mapOf("content-type" to "image/png", "x-asset-checksum" to digest(it)), it)
    },
    val cancelledStage: String? = null,
) : HTTPTransport {
    val calls = mutableListOf<String>()
    override suspend fun get(url: String, headers: Map<String, String>, maxBytes: Int) = request(url, "GET", headers, null, maxBytes)
    override suspend fun request(url: String, method: String, headers: Map<String, String>, body: String?, maxBytes: Int): HTTPResult {
        calls.add(url)
        val path = java.net.URI(url).path
        if (cancelledStage != null && path.contains("/$cancelledStage")) throw CancellationException("Cancelled transport")
        return when {
            path.endsWith("/session") -> session
            path.endsWith("/config") -> config
            else -> asset
        }
    }
}
