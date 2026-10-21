package com.rocento.mobile.builder

import com.rocento.mobile.*
import com.rocento.mobile.contract.HeroBanner
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

/** Ephemeral Studio capability. Never reads or writes enrollment or published caches. */
class DraftPreviewConfiguration(
    private val identity: AppBuilderIdentity,
    code: String,
    fallback: ByteArray,
    private val validator: ConfigValidator,
    private val transport: HTTPTransport,
) : StorefrontConfiguration {
    private val session = code.substringBefore('.')
    private val token = code.substringAfter('.')
    private val headers = mapOf("Authorization" to "Bearer $token")
    private val base = identity.configBase.trimEnd('/') + "/v1/mobile/preview/$session"
    private val query = "?merchantId=${identity.merchantId}&environment=${identity.environment}&runtimeVersion=${identity.runtime}"
    private var snapshot = ConfigSnapshot(validator.decode(fallback, identity.app, true), "bundled")
    private var applied = -1L
    private var lastChecksum: String? = null
    init {
        require(code.matches(Regex("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\\.[a-f0-9]{64}")))
    }
    // Normal shopping refresh never competes with the draft apply/ACK transaction.
    override suspend fun refresh(locale: String): ConfigSnapshot = snapshot

    suspend fun render(locale: String, apply: (ConfigSnapshot) -> Unit) {
        try {
            val result = transport.get("$base$query", headers, 131072)
            currentCoroutineContext().ensureActive()
            val revision = result.header("x-preview-revision")?.toLongOrNull() ?: throw MobileFailure("Invalid preview")
            val checksum = digest(result.body)
            if (result.status != 200 || result.header("x-preview-session") != session ||
                result.header("x-config-checksum") != checksum || revision < applied) throw MobileFailure("Invalid preview")
            if (revision == applied && lastChecksum != checksum) throw MobileFailure("Conflicting preview revision")
            val config = validator.decode(result.body, identity.app, true)
            val assets = mutableMapOf<String, ByteArray>()
            var total = 0
            for (id in (listOf(config.brand.logoAssetId) + config.screens.home.sections.flatMap { (it as? HeroBanner)?.props?.let { p -> listOf(p.imageAssetId) + p.additionalImageAssetIds.orEmpty() } ?: emptyList() }).distinct()) {
                // Asset IDs are immutable; retain verified bytes across preview polls.
                snapshot.assets[id]?.let { cached ->
                    total += cached.size
                    assets[id] = cached
                }
                if (total > 20 * 1024 * 1024) { assets.remove(id); break }
                if (id in assets) continue
                val asset = transport.get("$base/assets/$id$query", headers, 5 * 1024 * 1024)
                if (asset.status != 200 || asset.header("x-asset-checksum") != digest(asset.body)) break
                total += asset.body.size
                if (total > 20 * 1024 * 1024) break
                assets[id] = asset.body
            }
            currentCoroutineContext().ensureActive()
            snapshot = ConfigSnapshot(config, "draft", assets)
            apply(snapshot)
            val ack = transport.request("$base/ack$query", "POST", headers,
                "{\"revision\":$revision,\"checksum\":\"$checksum\"}", 4096)
            currentCoroutineContext().ensureActive()
            if (ack.status == 200) { applied = revision; lastChecksum = checksum }
        } catch (e: CancellationException) { throw e }
          catch (_: Exception) { currentCoroutineContext().ensureActive() }
    }
}
