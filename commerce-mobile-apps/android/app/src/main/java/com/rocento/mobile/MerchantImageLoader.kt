package com.rocento.mobile

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.SystemClock
import android.util.LruCache
import java.io.File
import kotlinx.coroutines.*
import okhttp3.Cache

/** One HTTP/disk cache per process and a bounded, expiring cache of decoded thumbnails. */
internal class MerchantImageLoader private constructor(context: Context) {
    private data class Cached(val bitmap: Bitmap, val expires: Long)
    private val decoded = object : LruCache<String, Cached>(32 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Cached) = value.bitmap.allocationByteCount
    }
    private val data = ImageDataLoader(OkHTTPTransport(OkHTTPTransport.sharedClient.newBuilder()
        .cache(Cache(File(context.cacheDir, "public-catalog-images"), 64L * 1024 * 1024)).build()))

    suspend fun load(url: String, pixels: Int = 480): Bitmap = withContext(Dispatchers.IO) {
        val key = "$url|$pixels"
        decoded.get(key)?.takeIf { it.expires > SystemClock.elapsedRealtime() }?.let { return@withContext it.bitmap }
        val bytes = data.load(url)
        ensureActive()
        decoded.get(key)?.takeIf { it.expires > SystemClock.elapsedRealtime() }?.let { return@withContext it.bitmap }
        val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
        require(options.outWidth > 0 && options.outHeight > 0)
        options.inJustDecodeBounds = false
        options.inSampleSize = 1
        val bound = pixels.coerceIn(1, 2048)
        while (options.outWidth / options.inSampleSize > bound || options.outHeight / options.inSampleSize > bound) options.inSampleSize *= 2
        val image = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options) ?: error("Invalid image")
        ensureActive()
        decoded.put(key, Cached(image, SystemClock.elapsedRealtime() + 300_000))
        image
    }

    companion object {
        @Volatile private var instance: MerchantImageLoader? = null
        fun get(context: Context): MerchantImageLoader = instance ?: synchronized(this) {
            instance ?: MerchantImageLoader(context.applicationContext).also { instance = it }
        }
    }
}
