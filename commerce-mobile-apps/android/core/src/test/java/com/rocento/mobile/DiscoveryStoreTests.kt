package com.rocento.mobile

import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Test
import kotlinx.serialization.json.*

private fun discoveryProduct(id: String) = Product(id,id,"","1","USD",inStock=true)
private class DiscoveryCatalog(val gate: CompletableDeferred<Unit>? = null, val started: CompletableDeferred<Unit>? = null): CatalogServing {
    override suspend fun categories(locale: String) = emptyList<Category>()
    override suspend fun products(category: String?, locale: String) = listOf(discoveryProduct(locale))
    override suspend fun product(id: String, locale: String): Product {
        if(id=="old") { started?.complete(Unit); gate?.await() }
        return discoveryProduct(id)
    }
    override suspend fun browse(category: String, filters: CatalogFilters, offset: Int, locale: String): CatalogPage {
        if(category=="old") { started?.complete(Unit); gate?.await() }
        return CatalogPage((if(offset==0)listOf(category,category)else listOf(category,"next")).map(::discoveryProduct),4)
    }
}
private class DiscoveryAssistant(val gate: CompletableDeferred<Unit>? = null, val started: CompletableDeferred<Unit>? = null, val fail: Boolean = false): AssistantServing {
    var calls=0
    override suspend fun setLocale(value: String) {}
    override suspend fun streamAssistant(input: AssistantInput, onEvent: suspend (AssistantEvent)->Unit) {
        calls++; started?.complete(Unit); gate?.await()
        if(fail)throw CommerceFailure(401,"Sign in")
        onEvent(AssistantEvent("1",input.request_id,0,"message.delta",text="Review",code="open_checkout",response_source="R"))
        onEvent(AssistantEvent("1",input.request_id,1,"done"))
    }
}
@OptIn(ExperimentalCoroutinesApi::class)
class DiscoveryStoreTests {
    @Test fun lateProductCannotReplaceNewSelection() = runTest {
        val gate=CompletableDeferred<Unit>(); val started=CompletableDeferred<Unit>()
        val store=CatalogStore(DiscoveryCatalog(gate,started),this)
        val old=async { store.product("old") }; started.await()
        store.dismissProduct(); store.product("new"); gate.complete(Unit)
        try { old.await(); fail("stale selection") } catch(_:CancellationException) {}
        assertEquals("new",store.selectedProduct?.id); assertTrue(store.variants.isEmpty())
    }
    @Test fun staleSearchAndRawOffsetPagination() = runTest {
        val gate=CompletableDeferred<Unit>(); val started=CompletableDeferred<Unit>()
        val store=CatalogStore(DiscoveryCatalog(gate,started),this)
        store.category("old"); started.await(); store.category("new"); runCurrent(); gate.complete(Unit); runCurrent()
        assertEquals(listOf("new"),store.categoryProducts.map{it.id})
        store.browseCategory(true); runCurrent()
        assertEquals(listOf("new","next"),store.categoryProducts.map{it.id}); assertFalse(store.categoryHasMore)
    }
    @Test fun localeChangeClearsCatalogAndProduct() = runTest {
        val store=CatalogStore(DiscoveryCatalog(),this); store.load(listOf("home")); store.product("a")
        store.changeLocale("ar"); assertTrue(store.products.isEmpty()); assertNull(store.selectedProduct)
        store.load(listOf("home")); assertEquals("ar",store.products.first().id)
    }
    @Test fun resetDiscardsOldStreamAndDoesNotRefreshNewAccount() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val gate=CompletableDeferred<Unit>(); val started=CompletableDeferred<Unit>()
            val store=AssistantStore(DiscoveryAssistant(gate,started),this)
            store.send("hello","en",settled={fail("old refresh")},checkout={fail("old navigation")})
            started.await(); store.reset(); gate.complete(Unit); runCurrent()
            assertTrue(store.turns.isEmpty()); assertFalse(store.busy)
        } finally { Dispatchers.resetMain() }
    }
    @Test fun stopSettlesOnceAndDoesNotReplay() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val gate=CompletableDeferred<Unit>(); val started=CompletableDeferred<Unit>(); val client=DiscoveryAssistant(gate,started)
            val store=AssistantStore(client,this); var settlements=0
            store.send("review","en",settled={assertTrue(store.busy);settlements++},checkout={fail("cancelled navigation")})
            started.await(); store.stop(); runCurrent()
            assertEquals(1,settlements); assertEquals(1,client.calls); assertTrue(store.turns.first().interrupted); assertFalse(store.busy)
        } finally { Dispatchers.resetMain() }
    }
    @Test fun duplicateSendIsBlockedUntilSettlementCompletes() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val gate=CompletableDeferred<Unit>(); val client=DiscoveryAssistant(); val store=AssistantStore(client,this); var opened=0
            store.send("review","en",settled={gate.await()},checkout={opened++}); runCurrent()
            store.send("duplicate","en",settled={},checkout={}); runCurrent()
            assertEquals(1,client.calls); assertEquals(0,opened); gate.complete(Unit); runCurrent()
            assertEquals(1,opened); assertFalse(store.busy)
        } finally { Dispatchers.resetMain() }
    }
    @Test fun uncertainProposalChecksStatusWithoutRepeatedMutation() = runTest {
        var applied=false; var mutations=0; var settled=0
        val store=AssistantProposalStore { buildJsonObject { put("can_apply",true); put("applied",applied); put("expires_at","2099-01-01T00:00:00Z") } }
        store.reload { settled++ }
        store.apply(false,operation={mutations++;throw IllegalStateException("lost response")},settled={settled++})
        store.apply(false,operation={mutations++},settled={settled++})
        assertEquals(1,mutations);assertTrue(store.state.value.pending)
        applied=true;store.reload{settled++}
        assertFalse(store.state.value.pending);assertFalse(store.canApply);assertEquals(1,settled)
    }
    @Test fun productPromptResetDiscardsLateResults() = runTest {
        val store=ProductPromptStore();val gate=CompletableDeferred<Unit>();val started=CompletableDeferred<Unit>()
        val old=launch { store.load { started.complete(Unit);gate.await();listOf(discoveryProduct("old")) } }
        started.await();store.reset();store.load{listOf(discoveryProduct("new"))};store.select("new",true)
        gate.complete(Unit);old.join()
        assertEquals(listOf("new"),store.state.value.products.map{it.id});assertEquals(setOf("new"),store.state.value.selected)
    }

    @Test fun stopDuringSettlementSuppressesCheckoutNavigation() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val gate=CompletableDeferred<Unit>();val store=AssistantStore(DiscoveryAssistant(),this);var opened=0
            store.send("review","en",settled={gate.await()},checkout={opened++});runCurrent()
            store.stop();gate.complete(Unit);runCurrent();assertEquals(0,opened);assertFalse(store.busy)
        } finally { Dispatchers.resetMain() }
    }

}
