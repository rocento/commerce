package com.rocento.mobile

import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.HttpUrl.Companion.toHttpUrl

/** Shares public-media reads, but never customer credentials or authenticated responses. */
class ImageDataLoader(
    private val transport: HTTPTransport,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
) {
    private data class Flight(val task: Deferred<ByteArray>, var readers: Int = 0)
    private val mutex = Mutex()
    private val flights = mutableMapOf<String, Flight>()

    suspend fun load(url: String): ByteArray {
        currentCoroutineContext().ensureActive()
        val parsed = url.toHttpUrl()
        require(parsed.isHttps && parsed.username.isEmpty() && parsed.password.isEmpty())
        val flight = mutex.withLock {
            flights.getOrPut(url) {
                Flight(scope.async {
                    var response = transport.get(url, emptyMap(), 5 * 1024 * 1024)
                    ensureActive()
                    if (response.status == 404 && parsed.queryParameter("width") != null) {
                        response = transport.get(parsed.newBuilder().removeAllQueryParameters("width").build().toString(), emptyMap(), 5 * 1024 * 1024)
                    }
                    ensureActive()
                    require(response.status == 200 && response.body.size <= 5 * 1024 * 1024)
                    response.body
                })
            }.also { it.readers++ }
        }
        try { return flight.task.await() }
        finally {
            withContext(NonCancellable) {
                mutex.withLock {
                    flight.readers--
                    if (flight.readers == 0) { flights.remove(url); flight.task.cancel() }
                }
            }
        }
    }
}
