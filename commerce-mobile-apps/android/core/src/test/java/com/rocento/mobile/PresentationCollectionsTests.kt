package com.rocento.mobile

import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PresentationCollectionsTests {
    private class Catalog : CatalogServing {
        val requests = mutableListOf<Pair<String?, String>>()
        var gate: CompletableDeferred<Unit>? = null
        var fail = false
        override suspend fun categories(locale: String) = emptyList<Category>()
        override suspend fun products(category: String?, locale: String): List<Product> {
            requests += category to locale
            gate?.await()
            if (fail) error("offline")
            return listOf(Product("$category-$locale", "Product", "", "1", "USD", inStock = true))
        }
        override suspend fun product(id: String, locale: String) = error("unused")
    }

    @Test fun addingReplacingAndRemovingCollectionsUpdatesProducts() = runTest {
        val source = Catalog(); val store = CatalogStore(source, this)
        val refresh = PresentationCollections(store, this)
        refresh.refresh(listOf("fruit"), "en").await().getOrThrow()
        refresh.refresh(listOf("fruit", "bread", "bread"), "en").await().getOrThrow()
        assertEquals(setOf("fruit", "bread"), store.collections.keys)
        assertEquals("bread-en", store.collections["bread"]!!.single().id)
        refresh.refresh(listOf("milk"), "en").await().getOrThrow()
        assertEquals(setOf("milk"), store.collections.keys)
        refresh.refresh(emptyList(), "en").await().getOrThrow()
        assertTrue(store.collections.isEmpty())
    }

    @Test fun pollingAndReorderingDoNotCancelSlowWorkOrRefetchSuccessfulWork() = runTest {
        val source = Catalog(); source.gate = CompletableDeferred()
        val store = CatalogStore(source, this); val refresh = PresentationCollections(store, this)
        val first = refresh.refresh(listOf("fruit", "bread"), "en")
        runCurrent()
        repeat(3) { advanceTimeBy(2000); assertSame(first, refresh.refresh(listOf("bread", "fruit"), "en")) }
        source.gate!!.complete(Unit); first.await().getOrThrow()
        assertSame(first, refresh.refresh(listOf("fruit", "bread"), "en"))
        assertEquals(3, source.requests.size)
    }

    @Test fun changedCollectionsCancelStaleWorkAndLanguageRefreshesNames() = runTest {
        val source = Catalog(); source.gate = CompletableDeferred()
        val store = CatalogStore(source, this); val refresh = PresentationCollections(store, this)
        val old = refresh.refresh(listOf("old"), "en"); runCurrent()
        source.gate = null
        refresh.refresh(listOf("new"), "ar").await().getOrThrow()
        assertTrue(old.isCancelled)
        assertEquals(setOf("new"), store.collections.keys)
        assertEquals("new-ar", store.collections["new"]!!.single().id)
    }

    @Test fun failedRequestRetriesAndExplicitRefreshReloadsSameCollection() = runTest {
        val source = Catalog(); source.fail = true
        val store = CatalogStore(source, this); val refresh = PresentationCollections(store, this)
        assertTrue(refresh.refresh(listOf("fruit"), "en").await().isFailure)
        source.fail = false
        val retry = refresh.refresh(listOf("fruit"), "en"); retry.await().getOrThrow()
        val forced = refresh.refresh(listOf("fruit"), "en", force = true)
        assertNotSame(retry, forced); forced.await().getOrThrow()
        assertEquals("fruit-en", store.collections["fruit"]!!.single().id)
    }
}
