package com.rocento.mobile.builder

import com.rocento.mobile.*

import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

@Serializable
private data class DeviceSession(
    val deviceId: String,
    val deviceToken: String? = null,
    val accessToken: String,
    val expiresIn: Int,
    val merchantId: String,
    val platform: String,
    val identifier: String,
    val environment: String,
)

/** Owner-approved internal config access, separate from customer and administrator credentials. */
class EnrollmentClient(
    private val identity: AppBuilderIdentity,
    private val identifier: String,
    private val storage: CredentialStorage,
    private val transport: HTTPTransport = OkHTTPTransport(),
) {
    private val mutex = Mutex()
    private var access: String? = null
    private var expires = 0L

    fun connected() = storage.read() != null

    suspend fun enroll(code: String) = mutex.withLock {
        val value = code.trim()
        require(value.matches(Regex("[a-fA-F0-9]{64}")))
        val result = exchange("enroll", mapOf("code" to value))
        val device = result.deviceToken ?: throw MobileFailure("Invalid enrollment")
        if (!device.matches(Regex("[a-fA-F0-9]{64}"))) throw MobileFailure("Invalid enrollment")
        storage.save(device)
        accept(result)
    }

    suspend fun token(): String? = mutex.withLock {
        if (access != null && expires > System.currentTimeMillis()) return@withLock access
        val device = storage.read() ?: return@withLock null
        try {
            val result = exchange("session", mapOf("deviceToken" to device))
            accept(result)
            result.accessToken
        } catch (e: MobileFailure) {
            if (e.reason == "Unauthorized") {
                storage.save(null)
                access = null
                expires = 0
            }
            throw e
        }
    }

    private fun accept(result: DeviceSession) {
        access = result.accessToken
        expires = System.currentTimeMillis() + (result.expiresIn - 60) * 1000L
    }

    private suspend fun exchange(path: String, credential: Map<String, String>): DeviceSession {
        currentCoroutineContext().ensureActive()
        val body =
            credential +
                mapOf(
                    "merchantId" to identity.merchantId,
                    "platform" to "android",
                    "identifier" to identifier,
                )
        val result =
            transport.request(
                identity.configBase.trimEnd('/') + "/v1/mobile/$path",
                "POST",
                mapOf("Content-Type" to "application/json", "X-Commerce-Request" to "1"),
                configJson.encodeToString(body),
                8192,
            )
        currentCoroutineContext().ensureActive()
        if (result.status in listOf(401, 403)) throw MobileFailure("Unauthorized")
        if (result.status != 200) throw MobileFailure("Connection unavailable")
        val session = configJson.decodeFromString<DeviceSession>(result.body.decodeToString())
        if (
            session.merchantId != identity.merchantId ||
                session.platform != "android" ||
                session.identifier != identifier ||
                session.environment != identity.environment ||
                !session.accessToken.matches(Regex("[a-fA-F0-9]{64}")) ||
                session.expiresIn !in 120..3600
        )
            throw MobileFailure("Invalid enrollment")
        java.util.UUID.fromString(session.deviceId)
        return session
    }

    suspend fun asset(id: String, locale: String): ByteArray {
        java.util.UUID.fromString(id)
        val token = token() ?: throw MobileFailure("Unauthorized")
        val url =
            identity.configBase.trimEnd('/') +
                "/v1/mobile/assets/$id/content?platform=android&runtimeVersion=${identity.runtime}&locale=${if(locale=="ar")"ar" else "en"}"
        val result = transport.get(url, mapOf("Authorization" to "Bearer $token"), 5 * 1024 * 1024)
        currentCoroutineContext().ensureActive()
        if (
            result.status != 200 ||
                result.header("content-type") != "image/png" ||
                result.header("x-asset-checksum") != digest(result.body)
        )
            throw MobileFailure("Invalid asset")
        return result.body
    }
}
