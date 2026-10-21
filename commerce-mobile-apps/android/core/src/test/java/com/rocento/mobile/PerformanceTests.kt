package com.rocento.mobile

import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PerformanceTests {
    @Test fun realCommerceCatalogDoesNotSerializeReadsOrMixLocales() = runTest {
        val gate=CompletableDeferred<Unit>(); val languages=mutableListOf<String>()
        val transport=object:HTTPTransport {
            override suspend fun get(url:String,headers:Map<String,String>,maxBytes:Int):HTTPResult {
                languages+=headers.getValue("X-Storefront-Locale")
                assertFalse(headers.containsKey("Authorization")); gate.await()
                return HTTPResult(200,body="[]".toByteArray())
            }
        }
        val client=CommerceClient(AppIdentity("312f9ac8-4888-4d35-92a0-e5fdb3bf59b8","production","https://one.example/api"),MemoryCredential(),MemoryCredential(),transport)
        val english=async { client.categories("en") }; val arabic=async { client.categories("ar") }
        runCurrent(); assertEquals(listOf("en","ar"),languages)
        gate.complete(Unit); english.await(); arabic.await()
    }
    @Test fun catalogReadsOverlapButStayBounded() = runTest {
        var active = 0; var peak = 0; var completed = 0
        suspend fun work() { active++; peak=maxOf(peak,active); try { delay(20) } finally { active--; completed++ } }
        val provider=object: CatalogServing {
            override suspend fun categories(locale:String): List<Category> { work(); return emptyList() }
            override suspend fun products(category:String?,locale:String): List<Product> { work(); return emptyList() }
            override suspend fun product(id:String,locale:String):Product = error("unused")
        }
        val store=CatalogStore(provider,this)
        store.load((0 until 12).map { it.toString() })
        assertEquals(4,peak); assertEquals(14,completed); assertEquals(12,store.collections.size)
    }
    @Test fun oldHomeLoadCannotPublishAfterLocaleChange() = runTest {
        val gate=CompletableDeferred<Unit>()
        val provider=object: CatalogServing {
            override suspend fun categories(locale:String): List<Category> { gate.await(); return emptyList() }
            override suspend fun products(category:String?,locale:String): List<Product> { gate.await(); return emptyList() }
            override suspend fun product(id:String,locale:String):Product = error("unused")
        }
        val store=CatalogStore(provider,this)
        val old=launch { store.load(listOf("old")) }; runCurrent(); store.changeLocale("ar"); gate.complete(Unit); old.join()
        assertTrue(store.collections.isEmpty()); store.load(listOf("new")); assertEquals(setOf("new"),store.collections.keys)
    }
    @Test fun imageReadsCoalesceAndCancelOnlyAfterLastReader() = runTest {
        var calls=0; var cancelled=false
        val gate=CompletableDeferred<Unit>()
        val transport=object:HTTPTransport {
            override suspend fun get(url:String,headers:Map<String,String>,maxBytes:Int):HTTPResult {
                calls++; assertTrue(headers.isEmpty())
                try { gate.await() } catch(e:CancellationException) { cancelled=true; throw e }
                return HTTPResult(200,body=byteArrayOf(1,2,3))
            }
        }
        val loader=ImageDataLoader(transport,backgroundScope)
        val first=async { loader.load("https://one.example/image?width=480") }
        val second=async { loader.load("https://one.example/image?width=480") }
        runCurrent(); assertEquals(1,calls); first.cancel(); runCurrent(); assertFalse(cancelled)
        gate.complete(Unit); assertArrayEquals(byteArrayOf(1,2,3),second.await())
        val hanging=ImageDataLoader(object:HTTPTransport {
            override suspend fun get(url:String,headers:Map<String,String>,maxBytes:Int):HTTPResult {
                try { awaitCancellation() } finally { cancelled=true }
            }
        },backgroundScope)
        val last=launch { hanging.load("https://one.example/image") }; runCurrent(); last.cancel(); runCurrent()
        assertTrue(cancelled)
    }
    @Test fun imageFallbackPreservesOriginAndRevision() = runTest {
        val urls=mutableListOf<String>()
        val loader=ImageDataLoader(object:HTTPTransport {
            override suspend fun get(url:String,headers:Map<String,String>,maxBytes:Int):HTTPResult {
                urls+=url; return HTTPResult(if("width=" in url)404 else 200,body=byteArrayOf(1))
            }
        },backgroundScope)
        loader.load("https://one.example/image?width=480&revision=3")
        loader.load("https://two.example/image?width=480&revision=3")
        assertEquals(listOf("https://one.example/image?width=480&revision=3","https://one.example/image?revision=3","https://two.example/image?width=480&revision=3","https://two.example/image?revision=3"),urls)
    }
}
