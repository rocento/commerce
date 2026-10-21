package com.rocento.mobile.builder

import com.rocento.mobile.*
import com.rocento.mobile.contract.HeroBanner
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

/** Builder outages preserve the last validated design and never block commerce. */
class AppBuilderConfiguration(
    identity: AppBuilderIdentity, identifier: String, storage: CredentialStorage,
    directory: File, fallback: ByteArray, validator: ConfigValidator,
    transport: HTTPTransport = OkHTTPTransport(),
) : StorefrontConfiguration {
    val enrollment = EnrollmentClient(identity, identifier, storage, transport)
    private val store = ConfigStore(identity, directory, fallback, validator, transport)
    override suspend fun refresh(locale: String): ConfigSnapshot {
        currentCoroutineContext().ensureActive()
        val snapshot = try {
            val token = enrollment.token() ?: return store.load()
            store.fetch(token, locale)
        }
            catch (e: CancellationException) { throw e }
            catch (_: Exception) {
                currentCoroutineContext().ensureActive()
                // Do not retry a failed session/config request for each optional image.
                return store.load()
            }
        val assets = mutableMapOf<String, ByteArray>()
        if (enrollment.connected()) {
            val ids = (listOf(snapshot.config.brand.logoAssetId) + snapshot.config.screens.home.sections
                .flatMap { (it as? HeroBanner)?.props?.let { p -> listOf(p.imageAssetId) + p.additionalImageAssetIds.orEmpty() } ?: emptyList() }).distinct()
            var total = 0
            for (id in ids) {
                try {
                    val bytes = enrollment.asset(id, locale)
                    if (total + bytes.size <= 20 * 1024 * 1024) {
                        assets[id] = bytes
                        total += bytes.size
                    }
                } catch (e: CancellationException) { throw e }
                  catch (_: Exception) {
                    currentCoroutineContext().ensureActive()
                    // Use native artwork after the first failure this refresh.
                    break
                  }
            }
        }
        currentCoroutineContext().ensureActive()
        return snapshot.copy(assets = assets)
    }
}
