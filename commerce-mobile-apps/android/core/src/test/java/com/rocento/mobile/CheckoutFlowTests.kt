package com.rocento.mobile

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import kotlinx.serialization.decodeFromString
import org.junit.Assert.*
import org.junit.Test

class CheckoutFlowTests {
    private val json = Json { ignoreUnknownKeys = true }
    private val fixture = json.parseToJsonElement(javaClass.classLoader!!.getResource("commerce-flow.json")!!.readText()).jsonObject
    private val quote = json.decodeFromString<CommerceQuote>(fixture.getValue("quote").toString())
    private val detail = json.decodeFromString<CustomerOrderDetail>(fixture.getValue("detail").toString())
    @Test fun reviewAndInvalidation() = runTest {
        val flow = CheckoutFlow()
        flow.loadOptions { json.decodeFromString<FulfillmentOptions>(fixture.getValue("options").toString()) }
        flow.review { quote }; assertEquals(CheckoutPhase.READY, flow.state.value.phase)
        flow.invalidate(); assertEquals(CheckoutState(), flow.state.value)
    }
    @Test fun giftDraftValidationInvalidationAndRecovery() = runTest {
        val flow = CheckoutFlow(); flow.setGiftMessage("For you")
        flow.loadOptions { json.decodeFromString<FulfillmentOptions>(fixture.getValue("options").toString()) }
        assertEquals("For you", flow.state.value.giftMessage)
        flow.review { quote }; flow.setGiftMessage("Changed"); assertNull(flow.state.value.quote)
        flow.invalidate(); assertEquals("Changed", flow.state.value.giftMessage)
        flow.setGiftMessage("ع".repeat(251))
        try { flow.review { fail("Oversize message sent"); quote }; fail() } catch (_: CommerceFailure) {}
        flow.setGiftMessage("ع".repeat(250)); assertTrue(flow.state.value.giftMessageValid)
        flow.restore(quote.copy(snapshot = quote.snapshot.copy(gift_message = "Saved gift")))
        flow.setGiftMessage("Cannot change"); assertEquals("Saved gift", flow.state.value.giftMessage)
        flow.reset(); assertEquals("", flow.state.value.giftMessage)
    }
    @Test fun duplicateConfirmationAndCompletion() = runTest {
        val flow = CheckoutFlow(); flow.review { quote }; var calls = 0
        flow.place({
            calls++; flow.invalidate(); assertTrue(flow.state.value.locked)
            try { flow.place({ calls++; detail }, { null }); fail("Duplicate accepted") } catch (_: CommerceFailure) {}
            detail
        }, { null })
        assertEquals(1, calls); assertEquals(CheckoutPhase.COMPLETED, flow.state.value.phase)
    }
    @Test fun uncertainRetryPreservesQuote() = runTest {
        val flow = CheckoutFlow(); flow.review { quote }
        try { flow.place({ throw java.io.IOException("Lost response") }, { quote }); fail() } catch (_: java.io.IOException) {}
        flow.invalidate(); flow.edit(); assertEquals(CheckoutPhase.UNCERTAIN, flow.state.value.phase)
        flow.place({ assertEquals(quote, it); detail }, { null })
        assertEquals(CheckoutPhase.COMPLETED, flow.state.value.phase)
    }
    @Test fun storageFailureKeepsRecoveryLocked() = runTest {
        val flow = CheckoutFlow(); flow.restore(quote)
        try { flow.place({ throw java.io.IOException("Offline") }, { throw IllegalStateException("Storage unavailable") }); fail() } catch (_: java.io.IOException) {}
        assertEquals(CheckoutPhase.UNCERTAIN, flow.state.value.phase); assertEquals(quote, flow.state.value.quote)
    }
    @Test fun definitiveRejectionReturnsToEditing() = runTest {
        val flow = CheckoutFlow(); flow.restore(quote)
        try { flow.place({ throw CommerceFailure(409,"Expired") }, { null }); fail() } catch (_: CommerceFailure) {}
        assertEquals(CheckoutState(), flow.state.value)
    }
    @Test fun resetDiscardsLateQuoteAndOrder() = runTest {
        val flow = CheckoutFlow()
        try { flow.review { flow.reset(); quote }; fail() } catch (_: CancellationException) {}
        assertNull(flow.state.value.quote)
        flow.restore(quote); var pendingRead = false
        try { flow.place({ flow.reset(); detail }, { pendingRead = true; quote }); fail() } catch (_: CancellationException) {}
        assertFalse(pendingRead); assertEquals(CheckoutState(), flow.state.value)
    }
}
