package com.rocento.mobile

import kotlinx.coroutines.*
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

private fun savedProduct(id:String)=Product(id,id,"","1","USD",inStock=true)
private fun savedOrder(id:String)=CustomerOrder(id,1,"placed","1","USD","2026-10-01")
private fun savedDetail(id:String)=CustomerOrderDetail(savedOrder(id),listOf(CustomerOrderDetail.OrderHistory("event","placed","2026-10-01"),CustomerOrderDetail.OrderHistory("event","placed","2026-10-01")))
class SavedStateTests {
    @Test fun wishlistMissingEntriesAndPaging() = runTest {
        val store=WishlistStore({(0..24).map{it.toString()}},{id,_->if(id=="0")throw CommerceFailure(404,"gone") else savedProduct(id)},{_,_->})
        store.load("en");assertEquals(24,store.state.value.resolved.size);assertNull(store.state.value.products["0"])
        store.load("en",true);assertEquals(25,store.state.value.resolved.size)
        store.save("0",false);assertFalse("0" in store.state.value.ids)
    }
    @Test fun wishlistFailurePreservesSnapshotButLocaleChangeClearsTranslations() = runTest {
        var failing=false
        val store=WishlistStore({listOf("a")},{id,_->if(failing)throw IllegalStateException() else savedProduct(id)},{_,_->if(failing)throw IllegalStateException()})
        store.load("en");failing=true
        try{store.load("en");fail()}catch(_:IllegalStateException){}
        assertEquals(1,store.state.value.products.size)
        try{store.save("a",false);fail()}catch(_:IllegalStateException){}
        assertTrue("a" in store.state.value.ids)
        try{store.load("ar");fail()}catch(_:IllegalStateException){}
        assertTrue(store.state.value.products.isEmpty())
    }
    @Test fun wishlistResetDiscardsLateRead() = runTest {
        val gate=CompletableDeferred<Unit>();val started=CompletableDeferred<Unit>()
        val store=WishlistStore({started.complete(Unit);gate.await();listOf("private")},{id,_->savedProduct(id)},{_,_->})
        val request=async{store.load("en")};started.await();store.reset();gate.complete(Unit)
        try{request.await();fail()}catch(_:CancellationException){}
        assertTrue(store.state.value.ids.isEmpty())
    }
    @Test fun wishlistResetDiscardsLateMutation() = runTest {
        val gate=CompletableDeferred<Unit>();val started=CompletableDeferred<Unit>()
        val store=WishlistStore({emptyList()},{id,_->savedProduct(id)},{_,_->started.complete(Unit);gate.await()})
        val request=async{store.save("private",true)};started.await();store.reset();gate.complete(Unit)
        try{request.await();fail()}catch(_:CancellationException){}
        assertTrue(store.state.value.ids.isEmpty())
    }
    @Test fun inboxReadMarkersScopedAndRestored() = runTest {
        val prefs=MemoryNotificationPreferences()
        val store=NotificationsStore({listOf(savedOrder("a"))},{savedDetail(it)},prefs)
        store.refresh("alice");assertEquals(1,store.state.value.events.size)
        store.mark(listOf("a:event","unknown"));assertTrue(store.state.value.unread.isEmpty())
        store.refresh("bob");assertEquals(1,store.state.value.unread.size)
        val restored=NotificationsStore({listOf(savedOrder("a"))},{savedDetail(it)},prefs);restored.refresh("alice")
        assertTrue(restored.state.value.unread.isEmpty());assertEquals(1,restored.state.value.read.size)
    }
    @Test fun failedInboxPagePreservesSnapshotAndOffset() = runTest {
        var failing=false
        val store=NotificationsStore({listOf(savedOrder(if(it==0)"a" else "b"))},{if(failing)throw IllegalStateException() else savedDetail(it)},MemoryNotificationPreferences())
        store.refresh("alice");failing=true
        try{store.refresh("alice",true);fail()}catch(_:IllegalStateException){}
        assertEquals(1,store.state.value.events.size);assertEquals(1,store.state.value.offset)
        failing=false;store.refresh("alice",true);assertEquals(2,store.state.value.events.size)
    }
    @Test fun inboxResetDiscardsLateDetail() = runTest {
        val gate=CompletableDeferred<Unit>();val started=CompletableDeferred<Unit>()
        val store=NotificationsStore({listOf(savedOrder("a"))},{started.complete(Unit);gate.await();savedDetail(it)},MemoryNotificationPreferences())
        val request=async{store.refresh("alice")};started.await();store.reset();gate.complete(Unit)
        try{request.await();fail()}catch(_:CancellationException){}
        assertTrue(store.state.value.events.isEmpty());assertNull(store.state.value.owner)
    }
    @Test fun pausedInboxDoesNotFetchAndPreferenceSurvives() = runTest {
        var calls=0;val prefs=MemoryNotificationPreferences()
        val store=NotificationsStore({calls++;listOf(savedOrder("a"))},{savedDetail(it)},prefs)
        store.setEnabled(false);store.refresh("alice");assertEquals(0,calls)
        val restored=NotificationsStore({calls++;listOf(savedOrder("a"))},{savedDetail(it)},prefs)
        assertFalse(restored.state.value.enabled);restored.setEnabled(true);restored.refresh("alice");assertEquals(1,calls)
    }
}
