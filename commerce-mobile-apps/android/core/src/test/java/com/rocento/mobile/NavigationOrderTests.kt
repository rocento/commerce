package com.rocento.mobile

import kotlinx.coroutines.*
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

private fun historyOrder(id: String) = CustomerOrder(id,1,"placed","1","USD","2026-10-01")
private fun historyDetail(id: String) = CustomerOrderDetail(historyOrder(id),emptyList())
class NavigationOrderTests {
    @Test fun pagingUsesRawOffsetsAndStopsAtEmptyPage() = runTest {
        val offsets=mutableListOf<Int>()
        val store=OrderStore({ offset -> offsets.add(offset); if(offset==0) listOf(historyOrder("a"),historyOrder("a")) else emptyList() },{historyDetail(it)})
        store.refresh();store.refresh(true);store.refresh(true)
        assertEquals(listOf(0,2),offsets);assertEquals(1,store.state.value.orders.size);assertFalse(store.state.value.hasMore)
    }
    @Test fun failurePreservesHistoryAndRetryRecovers() = runTest {
        var failing=false
        val store=OrderStore({if(failing)error("offline") else listOf(historyOrder("a"))},{historyDetail(it)})
        store.refresh();failing=true
        try {store.refresh();fail()}catch(_:IllegalStateException){}
        assertTrue(store.state.value.failed);assertFalse(store.state.value.loading);assertEquals(1,store.state.value.orders.size)
        failing=false;store.refresh();assertFalse(store.state.value.failed)
    }
    @Test fun newSelectionAndCheckoutRejectLateDetail() = runTest {
        val gate=CompletableDeferred<CustomerOrderDetail>()
        val store=OrderStore({emptyList()},{if(it=="old")gate.await() else historyDetail(it)})
        val pending=async(start=CoroutineStart.UNDISPATCHED){store.track("old")}
        store.track("new");gate.complete(historyDetail("old"))
        try{pending.await();fail()}catch(_:CancellationException){}
        assertEquals("new",store.state.value.detail?.order?.id)
        val secondGate=CompletableDeferred<CustomerOrderDetail>()
        val next=OrderStore({emptyList()},{secondGate.await()})
        val nextRead=async(start=CoroutineStart.UNDISPATCHED){next.track("old")};next.show(historyDetail("checkout"));secondGate.complete(historyDetail("old"))
        try{nextRead.await();fail()}catch(_:CancellationException){}
        assertEquals("checkout",next.state.value.detail?.order?.id)
    }
    @Test fun resetRejectsHistoryAndNewDetailFailureClearsOldOrder() = runTest {
        val gate=CompletableDeferred<List<CustomerOrder>>()
        val store=OrderStore({gate.await()},{error("offline")})
        val pending=async(start=CoroutineStart.UNDISPATCHED){store.refresh()};store.reset();gate.complete(listOf(historyOrder("a")))
        try{pending.await();fail()}catch(_:CancellationException){}
        assertTrue(store.state.value.orders.isEmpty())
        store.show(historyDetail("old"));try{store.track("new");fail()}catch(_:IllegalStateException){}
        assertNull(store.state.value.detail);assertEquals("new",store.state.value.selectedID);assertTrue(store.state.value.detailFailed)
    }
    @Test fun navigationReturnsToHistoryAndClosesCartBeforeTab() {
        val nav=NavigationStore();nav.selectTab("account");nav.open("orders");nav.open("order");nav.back()
        assertEquals("orders",nav.state.value.panel)
        nav.selectTab("cart");nav.openCart("checkout");nav.back()
        assertEquals("cart",nav.state.value.tab);assertNull(nav.state.value.cartPanel)
        nav.back();assertEquals("home",nav.state.value.tab);assertFalse(nav.back())
    }
    @Test fun customerResetClearsRoutesAndNotificationReturn() {
        val nav=NavigationStore();nav.selectTab("account");nav.open("notification-order");nav.back();assertEquals("notifications",nav.state.value.panel)
        nav.presentAssistant(true);nav.resetCustomerRoutes();assertEquals(NavigationState(tab="account"),nav.state.value)
    }
}
