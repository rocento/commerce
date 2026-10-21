package com.rocento.mobile

import kotlinx.coroutines.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class FeatureStoreTests {
    private val json = Json { ignoreUnknownKeys = true }
    private val fixture = json.parseToJsonElement(javaClass.classLoader!!.getResource("commerce-flow.json")!!.readText()).jsonObject
    private val quote = json.decodeFromString<CommerceQuote>(fixture.getValue("quote").toString())
    private val cart = json.decodeFromString<CommerceCart>(fixture.getValue("cart").toString())
    private val customer = json.decodeFromString<CustomerAccount>(fixture.getValue("customer").toString())
    private fun identity() = AppIdentity(customer.id,"production","https://grocery.example.test/api")
    private fun auth() = HTTPResult(200,mapOf("Set-Cookie" to "customer_refresh=${"f".repeat(64)}; HttpOnly"),fixture.getValue("auth").toString().toByteArray())
    private fun client(replies:List<Result<HTTPResult>> = emptyList(),attempts:MemoryCredential = MemoryCredential()) = CommerceClient(identity(),MemoryCredential(),attempts,CommerceTransport(replies))

    @Test fun rejectedGuestLoginKeepsAuthenticationRouteForRetry() = runTest {
        val session=ShoppingSession(client(listOf(Result.success(HTTPResult(401,body="{\"error\":\"Invalid credentials\"}".toByteArray())))))
        session.navigation.selectTab("account"); session.navigation.open("auth")
        val succeeded=session.perform { session.account.login("fixture","incorrect") }
        assertFalse(succeeded); assertNull(session.account.state.value.customer)
        assertEquals("auth",session.navigation.state.value.panel)
        assertEquals("Invalid credentials",session.feedback.state.value.failure?.message)
    }

    @Test fun queuedOperationsRunInOrderAndRecoverFromErrors() = runTest {
        val queue = OperationCoordinator(); val gate = CompletableDeferred<Unit>(); val events = mutableListOf<Int>()
        val first = async(start=CoroutineStart.UNDISPATCHED) { queue.run { events+=1;gate.await();events+=2 } }
        val second = async(start=CoroutineStart.UNDISPATCHED) { queue.run { events+=3 } }
        assertEquals(listOf(1),events);assertEquals(2,queue.pending.value)
        gate.complete(Unit);first.await();second.await();assertEquals(listOf(1,2,3),events);assertFalse(queue.busy)
        try {queue.run {throw java.io.IOException("offline")};fail()}catch(_:java.io.IOException){}
        assertEquals(42,queue.run{42})
    }
    @Test fun sessionChangeCancelsQueuedWorkOnly() = runTest {
        val queue=OperationCoordinator();val gate=CompletableDeferred<Unit>();var executed=false
        val first=async(start=CoroutineStart.UNDISPATCHED){queue.run{gate.await()}}
        val second=async(start=CoroutineStart.UNDISPATCHED){queue.run{executed=true}}
        queue.invalidatePending();gate.complete(Unit);first.await()
        try{second.await();fail()}catch(_:CancellationException){}
        assertFalse(executed);queue.run{executed=true};assertTrue(executed);assertFalse(queue.busy)
    }
    @Test fun cancellationDoesNotBlockFollowingWork() = runTest {
        val queue=OperationCoordinator();val gate=CompletableDeferred<Unit>()
        val first=async(start=CoroutineStart.UNDISPATCHED){queue.run{gate.await()}}
        val second=async(start=CoroutineStart.UNDISPATCHED){queue.run{fail("Cancelled operation executed")}}
        second.cancel();gate.complete(Unit);first.await()
        try{second.await();fail()}catch(_:CancellationException){}
        assertEquals(42,queue.run{42});assertFalse(queue.busy)
    }
    @Test fun deliveryEditsInvalidateReviewButNotPendingOrder() = runTest {
        val checkout=CheckoutFlow();val form=DeliveryForm(checkout)
        checkout.review{quote};form.update{it.copy(method="pickup",source="branch")}
        assertNull(checkout.state.value.quote);assertNull(form.state.value.selection.location)
        checkout.restore(quote);form.update{it.copy(method="delivery")}
        assertEquals("pickup",form.state.value.method);assertEquals(quote,checkout.state.value.quote)
    }
    @Test fun guestLocationUsesCoverageWithoutSavingCustomerAddress() = runTest {
        val form=DeliveryForm(CheckoutFlow())
        val api=client(listOf(Result.success(HTTPResult(200,emptyMap(),fixture.getValue("coverage").toString().toByteArray()))))
        form.save(api,DeliveryPin(30.0,31.0),"Guest location","","","","",guest=true)
        assertEquals("Guest location",form.state.value.guestAddress)
        assertNull(form.state.value.selection.location)
        form.reset();assertNull(form.state.value.guestAddress)
    }
    @Test fun sessionResetClearsCustomerStateButNotDurableAttempts() = runTest {
        val attempts=MemoryCredential("saved-order-key");val session=ShoppingSession(client(attempts=attempts))
        session.account.accept(customer);session.cart.accept(cart);session.delivery.editAddress{it.copy(address="Private")}
        session.navigation.selectTab("account");session.navigation.open("order")
        session.orders.show(json.decodeFromString(fixture.getValue("detail").toString()));session.checkout.restore(quote)
        session.account.reset()
        assertNull(session.navigation.state.value.panel);assertNull(session.orders.state.value.detail)
        assertNull(session.cart.state.value);assertEquals(AccountState(),session.account.state.value)
        assertEquals("",session.delivery.state.value.addressDraft.address);assertFalse(session.checkout.state.value.locked)
        assertEquals("saved-order-key",attempts.value)
    }
    @Test fun lateLoginCannotRestoreResetAccount() = runTest {
        val started=CompletableDeferred<Unit>();val gate=CompletableDeferred<Unit>()
        val transport=object:HTTPTransport {
            override suspend fun get(url:String,headers:Map<String,String>,maxBytes:Int):HTTPResult {started.complete(Unit);gate.await();return auth()}
            override suspend fun request(url:String,method:String,headers:Map<String,String>,body:String?,maxBytes:Int)=get(url,headers,maxBytes)
        }
        val account=AccountStore(CommerceClient(identity(),MemoryCredential(),MemoryCredential(),transport))
        val login=async {account.login("fixture","test")};started.await();account.reset();gate.complete(Unit)
        try{login.await();fail()}catch(_:CancellationException){}
        assertNull(account.state.value.customer)
    }
    @Test fun cartMutationsLockAndRejectStaleResponses() = runTest {
        val checkout=CheckoutFlow();val store=CartStore(client(),checkout);var requested=false
        checkout.restore(quote)
        try{store.mutate{requested=true;cart};fail()}catch(e:CommerceFailure){assertEquals(409,e.status)}
        assertFalse(requested);checkout.reset()
        try{store.mutate{store.reset();cart};fail()}catch(_:CancellationException){}
        assertNull(store.state.value)
    }
    @Test fun cartFailureKeepsExistingCartAndInvalidatesQuote() = runTest {
        val checkout=CheckoutFlow();val store=CartStore(client(),checkout);store.accept(cart);checkout.review{quote}
        try{store.mutate{assertNull(checkout.state.value.quote);throw java.io.IOException("offline")};fail()}catch(_:java.io.IOException){}
        assertEquals(cart,store.state.value)
    }
    @Test fun pendingOrderRestoresBeforeUnrelatedReadsFail() = runTest {
        val attempts=MemoryCredential(json.encodeToString(mapOf(customer.id to CheckoutAttempt(customer.id,quote,"existing-key"))))
        val session=ShoppingSession(client(listOf(Result.success(auth()),Result.failure(java.io.IOException("offline"))),attempts))
        session.account.login("fixture","test")
        try{session.reload();fail()}catch(_:java.io.IOException){}
        assertTrue(session.checkout.state.value.locked);assertEquals(quote,session.checkout.state.value.quote)
    }
    @Test fun actionConfirmationSurvivesFollowupFailure() = runTest {
        val api = client(listOf(Result.success(auth()), Result.success(HTTPResult(200,emptyMap(),fixture.getValue("detail").toString().toByteArray())), Result.failure(java.io.IOException("offline"))))
        val session = ShoppingSession(api)
        session.account.login("fixture","test")
        session.checkout.review { quote }
        val ok = session.perform { session.actions.place { session.feedback.setNotice("Confirmed") } }
        assertFalse(ok); assertEquals("Confirmed",session.feedback.state.value.notice)
        assertNotNull(session.orders.state.value.detail); assertEquals(CheckoutPhase.COMPLETED,session.checkout.state.value.phase)
        assertNotNull(session.feedback.state.value.failure)
    }
    @Test fun actionStopsFollowupWhenConfirmationChangesSession() = runTest {
        val api = client(listOf(Result.success(auth()), Result.success(HTTPResult(200,emptyMap(),fixture.getValue("detail").toString().toByteArray()))))
        val session = ShoppingSession(api)
        session.account.login("fixture","test"); session.checkout.review { quote }
        try { session.actions.place { session.account.reset() }; fail() } catch (_: CancellationException) {}
        assertNull(session.orders.state.value.detail)
    }
    @Test fun guestDeliveryActionDoesNotReadAuthenticatedCart() = runTest {
        val session = ShoppingSession(client(listOf(Result.success(HTTPResult(200,emptyMap(),fixture.getValue("coverage").toString().toByteArray())))))
        session.actions.save(DeliveryPin(30.0,31.0),"Guest","","","","")
        assertEquals("Guest",session.delivery.state.value.guestAddress)
        assertNull(session.cart.state.value)
        session.actions.assistantSettled()
    }
    @Test fun loginPublishesAuthenticationBeforeRecoveryFailure() = runTest {
        val session = ShoppingSession(client(listOf(Result.success(auth()), Result.failure(java.io.IOException("offline")))))
        var authenticated = false
        try { session.actions.login("fixture","test") { authenticated = true }; fail() } catch (_: java.io.IOException) {}
        assertTrue(authenticated); assertNotNull(session.account.state.value.customer)
    }
    @Test fun logoutHookPrecedesAccountCleanupEvenWhenHookFails() = runTest {
        val session = ShoppingSession(client())
        session.account.accept(customer)
        try { session.actions.logout { assertNotNull(session.account.state.value.customer); throw java.io.IOException("push unavailable") }; fail() }
        catch (_: java.io.IOException) {}
        assertNull(session.account.state.value.customer)
    }

    @Test fun assistantProposalStopsDeliveryFollowupAfterIdentityChange() = runTest {
        val api = client(listOf(Result.success(auth()), Result.success(HTTPResult(200,emptyMap(),"{}".toByteArray())), Result.success(HTTPResult(200,emptyMap(),fixture.getValue("cart").toString().toByteArray()))))
        val session = ShoppingSession(api)
        session.account.login("fixture","test")
        session.cart.onChange = { session.cart.onChange = null; session.account.reset() }
        try { session.actions.applyProposal("70000000-0000-0000-0000-000000000002","stale"); fail() }
        catch (_: CancellationException) {}
        assertNull(session.cart.state.value)
    }
    @Test fun loginCallbackCannotRecoverAnotherSession() = runTest {
        val session = ShoppingSession(client(listOf(Result.success(auth()))))
        try { session.actions.login("fixture","test") { session.account.reset() }; fail() }
        catch (_: CancellationException) {}
    }

    @Test fun deliveryActionInvalidatesQuoteAndRefreshesCart() = runTest {
        val replies = listOf(Result.success(auth())) + listOf("locations","availability","coverage","cart").map { Result.success(HTTPResult(200,emptyMap(),fixture.getValue(it).toString().toByteArray())) }
        val api = client(replies); val session = ShoppingSession(api)
        session.account.login("fixture","test")
        session.delivery.refresh(api); session.checkout.review { quote }
        session.actions.choose(session.delivery.state.value.locations[0].id)
        assertNull(session.checkout.state.value.quote); assertNotNull(session.cart.state.value)
    }

    @Test fun cancelledPushUnregistrationStillClearsCredentials() = runTest {
        val credentials = MemoryCredential("saved-refresh")
        val api = CommerceClient(identity(),credentials,MemoryCredential(),CommerceTransport(listOf(Result.success(HTTPResult(200,emptyMap(),"{}".toByteArray())))))
        val session = ShoppingSession(api); session.account.accept(customer)
        val started = CompletableDeferred<Unit>()
        val task = launch { session.actions.logout { started.complete(Unit); awaitCancellation() } }
        started.await(); task.cancelAndJoin()
        assertNull(session.account.state.value.customer); assertNull(credentials.read())
    }

    @Test fun runtimeOwnsSettingsAndSingleIdentityReset() = runTest {
        val settings = AppSettingsStore(locale="ar")
        val runtime = ShoppingRuntime(client(),settings,backgroundScope)
        assertSame(settings,runtime.settings); assertEquals("ar",runtime.catalog.locale)
        runtime.assistant.draft = "Private message"
        runtime.session.navigation.open("order")
        runtime.session.orders.show(json.decodeFromString<CustomerOrderDetail>(fixture.getValue("detail").toString()))
        var orderChanges = 0; runtime.session.orders.onChange = { orderChanges++ }
        var assistantChanges = 0; runtime.assistant.onChange = { assistantChanges++ }
        runtime.session.account.reset()
        assertEquals(1,orderChanges); assertEquals(1,assistantChanges)
        assertNull(runtime.session.orders.state.value.detail); assertEquals("",runtime.assistant.state.value.draft)
        assertEquals("ar",settings.state.value.locale)
    }

}
