package com.rocento.mobile.builder

import com.rocento.mobile.*
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.serialization.*

@Serializable
private data class CacheEnvelope(val body: String, val checksum: String, val etag: String)

class ConfigStore(
    val identity: AppBuilderIdentity,
    private val directory: File,
    private val fallback: ByteArray,
    private val validator: ConfigValidator,
    private val transport: HTTPTransport = OkHTTPTransport(),
) {
    private val mutex = kotlinx.coroutines.sync.Mutex()
    private val file
        get() = File(directory, identity.cacheKey + ".json")

    private fun cached(): CacheEnvelope? = runCatching {
        if (file.length() > 200000) throw MobileFailure("Cache too large")
        val v = configJson.decodeFromString<CacheEnvelope>(file.readText())
        val bytes = java.util.Base64.getDecoder().decode(v.body)
        if (v.checksum != digest(bytes) || v.etag != "\"mobile-${v.checksum}\"")
            throw MobileFailure("Corrupt cache")
        validator.decode(bytes, identity.app)
        v
    }
        .getOrNull()

    fun load(): ConfigSnapshot {
        val c = cached()
        return if (c != null)
            ConfigSnapshot(
                validator.decode(java.util.Base64.getDecoder().decode(c.body), identity.app),
                "cache",
            )
        else ConfigSnapshot(validator.decode(fallback, identity.app, true), "bundled")
    }

    suspend fun refresh(token: String?, locale: String): ConfigSnapshot = try {
        fetch(token, locale)
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        currentCoroutineContext().ensureActive()
        if (e is MobileFailure && e.reason == "Unauthorized") throw e
        load()
    }

    // A successful 304 must be distinguishable from an unavailable builder.
    internal suspend fun fetch(token: String?, locale: String): ConfigSnapshot {
        currentCoroutineContext().ensureActive()
        mutex.lock()
        try {
            if (token.isNullOrBlank()) return load()
            val previous = cached()
            val headers = mutableMapOf("Authorization" to "Bearer $token")
            previous?.let { headers["If-None-Match"] = it.etag }
            val url =
                identity.configBase.trimEnd('/') +
                    "/v1/mobile/config?platform=android&runtimeVersion=${identity.runtime}&locale=${if(locale=="ar") "ar" else "en"}"
            val response = transport.get(url, headers, 131072)
            currentCoroutineContext().ensureActive()
            if (response.status in listOf(401, 403)) throw MobileFailure("Unauthorized")
            if (response.status == 304) {
                if (previous == null || response.header("etag") != previous.etag)
                    throw MobileFailure("Invalid 304")
                return load()
            }
            val hash = digest(response.body)
            if (
                response.status != 200 ||
                    response.header("x-config-checksum") != hash ||
                    response.header("etag") != "\"mobile-$hash\""
            )
                throw MobileFailure("Invalid response")
            val config = validator.decode(response.body, identity.app)
            previous?.let {
                val old =
                    validator.decode(java.util.Base64.getDecoder().decode(it.body), identity.app)
                if (
                    config.configVersion < old.configVersion ||
                        (config.configVersion == old.configVersion && hash != it.checksum)
                )
                    throw MobileFailure("Superseded response")
            }
            directory.mkdirs()
            val temp = File.createTempFile("config-", ".tmp", directory)
            try {
                temp.writeText(
                    configJson.encodeToString(
                        CacheEnvelope(
                            java.util.Base64.getEncoder().encodeToString(response.body),
                            hash,
                            "\"mobile-$hash\"",
                        ),
                    ),
                )
                Files.move(
                    temp.toPath(),
                    file.toPath(),
                    StandardCopyOption.ATOMIC_MOVE,
                    StandardCopyOption.REPLACE_EXISTING,
                )
            } finally {
                temp.delete()
            }
            return ConfigSnapshot(config, "network")
        } finally {
            mutex.unlock()
        }
    }
}
