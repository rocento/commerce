package com.rocento.mobile

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

class ShoppingWorkflowsTests {
    @Test fun guestAndRecoveryOrdering() = runTest {
        val calls = mutableListOf<String>(); var signedIn = false
        val workflows = ShoppingWorkflows(
            restoreAccount = { calls.add("account"); signedIn },
            recoverySteps = listOf("checkout", "delivery", "cart", "orders").map { name -> { calls.add(name); Unit } },
            revision = { 0 }, saveItem = {}, refreshWishlist = {})
        workflows.recover(); assertEquals(listOf("account"), calls)
        signedIn = true; calls.clear()
        workflows.recover(); assertEquals(listOf("account", "checkout", "delivery", "cart", "orders"), calls)
    }
    @Test fun identityChangeStopsRecoveryAndWishlistFollowup() = runTest {
        var generation = 0; var followups = 0
        val workflows = ShoppingWorkflows(
            restoreAccount = { true }, recoverySteps = listOf({ generation++ }, { followups++ }),
            revision = { generation }, saveItem = { generation++ }, refreshWishlist = { followups++ })
        try { workflows.recover(); fail("Expected cancellation") } catch (_: CancellationException) {}
        try { workflows.saveForLater("product"); fail("Expected cancellation") } catch (_: CancellationException) {}
        assertEquals(0, followups)
    }
    @Test fun failedRecoveryCanBeRetried() = runTest {
        var shouldFail = true; var content = 0
        val workflows = ShoppingWorkflows(restoreAccount = { true },
            recoverySteps = listOf({ if (shouldFail) throw CommerceFailure(503,"Offline") }, { content++ }),
            revision = { 0 }, saveItem = {}, refreshWishlist = {})
        try { workflows.recover(); fail("Expected failure") } catch (_: CommerceFailure) {}
        assertEquals(0, content); shouldFail = false
        workflows.recover(); assertEquals(1, content)
    }
}
