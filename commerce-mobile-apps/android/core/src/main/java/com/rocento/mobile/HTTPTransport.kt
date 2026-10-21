package com.rocento.mobile

import kotlinx.coroutines.*
import kotlinx.coroutines.withContext
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody

data class HTTPResult(
    val status: Int,
    val headers: Map<String, String> = emptyMap(),
    val body: ByteArray = byteArrayOf(),
) {
    fun header(key: String) = headers.entries.firstOrNull { it.key.equals(key, true) }?.value
}

interface HTTPTransport {
    suspend fun stream(url: String, headers: Map<String,String>, body: String, maxBytes: Int,
        onResponse: suspend (HTTPResult)->Unit, onChunk: suspend (ByteArray)->Boolean) {
        val response=request(url,"POST",headers,body,maxBytes)
        require(response.body.size<=maxBytes)
        onResponse(response);onChunk(response.body)
    }
    suspend fun get(url: String, headers: Map<String, String>, maxBytes: Int): HTTPResult
    suspend fun request(url: String, method: String, headers: Map<String,String>, body: String?, maxBytes: Int): HTTPResult {
        require(method == "GET"); return get(url,headers,maxBytes)
    }
}

class OkHTTPTransport(
    private val client: OkHttpClient = sharedClient,
) : HTTPTransport {
    companion object {
        val sharedClient: OkHttpClient = OkHttpClient.Builder()
            .followRedirects(false)
            .followSslRedirects(false)
            .callTimeout(java.time.Duration.ofSeconds(15))
            .build()
    }
    override suspend fun stream(url:String, headers:Map<String,String>, body:String, maxBytes:Int,
        onResponse:suspend (HTTPResult)->Unit, onChunk:suspend (ByteArray)->Boolean) = withContext(Dispatchers.IO) {
        val request=Request.Builder().url(url).post(body.toRequestBody("application/json".toMediaType()))
        headers.forEach{(k,v)->request.header(k,v)}
        val call=client.newBuilder().callTimeout(java.time.Duration.ofSeconds(40)).readTimeout(java.time.Duration.ofSeconds(35)).build().newCall(request.build())
        // A sibling promptly closes the socket when cancellation occurs during a blocking read.
        val closer=launch(Dispatchers.Default, start=CoroutineStart.UNDISPATCHED) {
            try {awaitCancellation()} finally {call.cancel()}
        }
        try {
            call.execute().use { response ->
                onResponse(HTTPResult(response.code,response.headers.names().associateWith{response.header(it).orEmpty()}))
                val source=response.body.byteStream()
                val chunk=ByteArray(4096);var total=0
                while(true) {
                    ensureActive()
                    val count=source.read(chunk);if(count<0)break
                    total+=count;if(total>maxBytes)throw AssistantStreamFailure()
                    if(onChunk(chunk.copyOf(count)))break
                }
            }
        } finally {closer.cancel();call.cancel()}
        Unit
    }
    override suspend fun get(url: String, headers: Map<String, String>, maxBytes: Int): HTTPResult = request(url,"GET",headers,null,maxBytes)
    override suspend fun request(url: String, method: String, headers: Map<String,String>, body: String?, maxBytes: Int): HTTPResult =
        withContext(Dispatchers.IO) {
            val req = Request.Builder().url(url).method(method, if(method in listOf("POST","PUT","PATCH")) (body ?: "").toRequestBody("application/json".toMediaType()) else null)
            headers.forEach { (k, v) -> req.header(k, v) }
            val call = client.newCall(req.build())
            val closer = launch(Dispatchers.Default, start = CoroutineStart.UNDISPATCHED) {
                try { awaitCancellation() } finally { call.cancel() }
            }
            try { call.execute().use { response ->
                val stream = response.body.byteStream()
                val output = java.io.ByteArrayOutputStream()
                val chunk = ByteArray(8192)
                while (true) {
                    ensureActive()
                    val count = stream.read(chunk)
                    if (count < 0) break
                    if (output.size() + count > maxBytes) throw MobileFailure("Response too large")
                    output.write(chunk, 0, count)
                }
                val bytes = output.toByteArray()
                HTTPResult(
                    response.code,
                    response.headers.names().associateWith { if(it.equals("set-cookie",true)) response.headers.values(it).joinToString(", ") else response.header(it).orEmpty() },
                    bytes,
                )
            } } finally { closer.cancel(); call.cancel() }
        }
}

