package com.rocento.mobile

import kotlinx.coroutines.*

/** Shares catalog work across repeated presentation snapshots on the UI dispatcher. */
class PresentationCollections(private val catalog: CatalogStore, private val scope: CoroutineScope) {
    private var key: Pair<String, Set<String>>? = null
    private var task: Deferred<Result<Unit>>? = null
    private var succeeded = false
    private var generation = 0

    fun refresh(ids: List<String>, locale: String, force: Boolean = false): Deferred<Result<Unit>> {
        val next = locale to ids.toSet()
        task?.let { if (!force && key == next && (it.isActive || succeeded)) return it }
        task?.cancel()
        key = next
        succeeded = false
        val request = ++generation
        catalog.changeLocale(locale)
        return scope.async {
            try {
                catalog.load(ids.distinct())
                ensureActive()
                if (request == generation) succeeded = true
                Result.success(Unit)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                // A later snapshot retries failed work; presentation remains usable.
                Result.failure(error)
            }
        }.also { task = it }
    }
}
