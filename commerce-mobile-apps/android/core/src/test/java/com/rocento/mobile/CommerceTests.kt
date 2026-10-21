package com.rocento.mobile

import java.io.IOException
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class MemoryCredential(var value:String?=null):CredentialStorage {override fun read()=value;override fun save(value:String?){this.value=value}}
class CommerceTransport(replies:List<Result<HTTPResult>>):HTTPTransport {
    data class Request(val url:String,val method:String,val headers:Map<String,String>,val body:String?)
    val requests=mutableListOf<Request>(); private val replies=replies.toMutableList()
    override suspend fun get(url:String,headers:Map<String,String>,maxBytes:Int)=request(url,"GET",headers,null,maxBytes)
    override suspend fun request(url:String,method:String,headers:Map<String,String>,body:String?,maxBytes:Int):HTTPResult {
        assertEquals(if(url.endsWith("analytics/events"))16384 else 2000000,maxBytes);requests.add(Request(url,method,headers,body));return replies.removeAt(0).getOrThrow()
    }
}
class CommerceTests {
    private val fixtureJson = Json { ignoreUnknownKeys = true }
    @Test fun inaccessibleCredentialsFailWithoutNetworkOrOverwrite() = runTest {
        val blocked = object : CredentialStorage {
            override fun read(): String? = error("Unchecked reads hide access failures")
            override fun readChecked(): String? = throw IOException("Storage unavailable")
            override fun save(value: String?) = error("Unreadable storage must not be overwritten")
        }
        val transport = CommerceTransport(emptyList())
        val client = CommerceClient(identity(), blocked, blocked, transport)
        try { client.restore(); fail("Expected checked read failure") } catch (_: IOException) {}
        assertTrue(transport.requests.isEmpty())
        val signedIn = CommerceClient(identity(), MemoryCredential(), blocked, CommerceTransport(listOf(auth())))
        signedIn.login("fixture", "test")
        try { signedIn.pendingCheckout(); fail("Expected checked read failure") } catch (_: IOException) {}
    }
    @Test fun sharedMalformedCommercePayloadsFailDecoding() {
        val fixture = javaClass.getResourceAsStream("/invalid-commerce.json")!!.bufferedReader().use { Json.parseToJsonElement(it.readText()).jsonObject }
        try { Json.decodeFromJsonElement<CustomerAuth>(fixture.getValue("malformed_auth")); fail() } catch (_: kotlinx.serialization.SerializationException) {}
        try { Json.decodeFromJsonElement<CommerceCart>(fixture.getValue("malformed_cart")); fail() } catch (_: kotlinx.serialization.SerializationException) {}
        try { Json.decodeFromJsonElement<CommerceQuote>(fixture.getValue("malformed_quote")); fail() } catch (_: kotlinx.serialization.SerializationException) {}
    }

    @Test fun passwordResetLogsOutOnceAndClearsAccount() = runTest {
        val transport = CommerceTransport(listOf(auth(), response(), response()))
        val credentials = MemoryCredential()
        val client = CommerceClient(identity(), credentials, MemoryCredential(), transport)
        val account = AccountStore(client)
        account.login("fixture", "test")
        account.auth("reset-password", "fixture", "replacement", "code")
        assertEquals(1, transport.requests.count { it.url.endsWith("/logout") })
        assertNull(account.state.value.customer)
        assertNull(credentials.read())
    }
    private fun memoryFixture(guest:Boolean=false)="""{"enabled":true,"guest":$guest,"personalized":true,"journey_consent":false,"consent_version":3,"preferences":[],"signals":[],"categories":[{"id":"$other","name":"Gifts"}],"products":[]}"""
    @Test fun memoryUnknownWriteRequiresReadbackAndResetClearsPrivateState()=runTest {
        val view=memoryFixture();val transport=CommerceTransport(listOf(auth(),response(view),response("[]"),response("""{"goals":[]}"""),response(status=503),response(view),response("[]"),response("""{"goals":[]}"""),response("""{"memory":$view,"contexts":[],"consents":[]}""")))
        val client=CommerceClient(identity(),MemoryCredential(),MemoryCredential(),transport);client.login("fixture","test")
        val store=AssistantLibrary(client);store.refresh(other,true);val draft=MemoryPreferenceInput(attribute="color",value="blue",category_id=other);store.edit(draft)
        repeat(2){try{store.mutate(MemoryAction.Preference(draft),other,true);fail()}catch(_:CommerceFailure){}}
        assertTrue(store.state.value.needsRefresh);assertEquals(draft,store.state.value.draft);assertEquals(1,transport.requests.count{it.method=="POST" && it.url.endsWith("preferences")})
        store.refresh(other,true);assertFalse(store.state.value.needsRefresh);store.export();assertTrue(store.state.value.exported!!.contains("consents"));store.reset();assertNull(store.state.value.exported);assertNull(store.state.value.memory);assertTrue(store.state.value.history.isEmpty())
    }
    @Test fun savedConversationRestoresWithoutStreamOrCheckoutAndMissingGoalFails()=runTest {
        val turn="""{"conversation_id":"$other","request_id":"$other","question":"Find a gift","answer":"Suggestion","created_at":"2026-10-13T00:00:00Z","blocks":[]}"""
        val transport=CommerceTransport(listOf(auth(),response("[$turn]"),response("[]"),response("""{"goals":[]}""")))
        val client=CommerceClient(identity(),MemoryCredential(),MemoryCredential(),transport);client.login("fixture","test")
        val store=AssistantLibrary(client);val chat=AssistantStore(client,this);store.open(other){chat.restoreConversation(other,it)}
        assertEquals(other,chat.conversationID);assertEquals("Find a gift",chat.state.value.turns.first().question);assertFalse(chat.state.value.turns.first().reply.checkoutRequested)
        try{store.open(other){fail("must not replace chat")};fail()}catch(_:CommerceFailure){}
        try{store.resumeGoal(other){fail("must not resume missing goal")};fail()}catch(_:CommerceFailure){}
        assertFalse(transport.requests.any{it.url.endsWith("chat")});val turns=Json.decodeFromString<List<HistoryTurn>>("[$turn,$turn]");try{validateHistory(turns);fail()}catch(_:IllegalArgumentException){}
    }
    @Test fun guestMemoryRetainsCookieAndFailsClosedWithoutOwnership()=runTest {
        val cookie="g".repeat(48);val transport=CommerceTransport(listOf(response(memoryFixture(true),headers=mapOf("Set-Cookie" to "assistant_guest=$cookie; HttpOnly")),response()))
        val client=CommerceClient(identity(),MemoryCredential(),MemoryCredential(),transport);client.memoryView(other);client.changeMemory(MemoryAction.Consent(false,false,3))
        assertEquals("assistant_guest=$cookie",transport.requests[1].headers["Cookie"]);assertNull(transport.requests[1].headers["Authorization"])
        val missing=CommerceClient(identity(),MemoryCredential(),MemoryCredential(),CommerceTransport(listOf(response(memoryFixture(true)))))
        try{missing.memoryView(other);fail()}catch(_:CommerceFailure){}
    }
    private fun supportFixture()="""{"ticket":{"id":"$other","number":42,"subject":"Delivery","category":"order_issue","status":"open","priority":"normal","order_id":"$other","created_at":"2026-10-13T00:00:00Z"},"messages":[{"id":"$other","sender":"customer","body":"Where is it?","created_at":"2026-10-13T00:00:00Z"}]}"""
    @Test fun supportCreateAndReplyRetryExactAttempts()=runTest {
        val detail=supportFixture();val ticket=Json.parseToJsonElement(detail).jsonObject.getValue("ticket")
        val transport=CommerceTransport(listOf(auth(),response(status=503),response(detail),response("[$ticket]"),response(detail),response(status=503),response(detail),response(detail)))
        val client=CommerceClient(identity(),MemoryCredential(),MemoryCredential(),transport);client.login("fixture","test")
        val store=SupportStore(client);val draft=SupportInput(subject="Delivery",body="Where is it?",order_id=other)
        store.compose(other);store.edit(draft)
        try{store.create(true);fail()}catch(_:CommerceFailure){}
        assertNotNull(store.state.value.attempt);store.edit(draft.copy(body="changed"));assertEquals("Where is it?",store.state.value.draft.body)
        store.create(true);assertTrue(store.state.value.created);assertNull(store.state.value.attempt)
        store.showList();store.refresh();assertEquals(1,store.state.value.tickets.size);store.open(other);store.editReply("Please check")
        try{store.sendReply();fail()}catch(_:CommerceFailure){}
        store.editReply("changed");assertEquals("Please check",store.state.value.reply);store.open(other);assertEquals("Please check",store.state.value.reply);store.sendReply();assertTrue(store.state.value.replied)
        val requests=transport.requests;assertEquals(requests[1].body,requests[2].body);assertEquals(requests[5].body,requests[7].body);assertEquals("Bearer customer-access",requests[7].headers["Authorization"])
        assertEquals(setOf("request_id","body"),Json.parseToJsonElement(requests[7].body!!).jsonObject.keys)
        assertFalse(draft.copy(body="ع".repeat(1001)).valid(true));store.reset();assertTrue(store.state.value.tickets.isEmpty());assertNull(store.state.value.detail)
    }
    @Test fun guestSupportCookieAndValidationFailure()=runTest {
        val cookie="g".repeat(48)
        val transport=CommerceTransport(listOf(response("""{"status":"ok"}""",headers=mapOf("Set-Cookie" to "support_guest=$cookie; HttpOnly")),response(status=503),response(supportFixture()),response(status=422)))
        val client=CommerceClient(identity(),MemoryCredential(),MemoryCredential(),transport)
        val store=SupportStore(client);val draft=SupportInput(subject="Question",body="Please help",contact_name="Mona",contact="mona@example.test");store.edit(draft)
        try{store.create(false);fail()}catch(_:CommerceFailure){}
        store.create(false);val requests=transport.requests
        assertEquals(3,requests.size);assertEquals(requests[1].body,requests[2].body);assertEquals("support_guest=$cookie",requests[1].headers["Cookie"]);assertNull(requests[1].headers["Authorization"])
        store.compose();store.edit(draft);try{store.create(false);fail()}catch(_:CommerceFailure){};assertNull(store.state.value.attempt)
    }
    @Test fun orderContentsDecodeWithoutBreakingOlderResponses() {
        val fixture=Json.parseToJsonElement(javaClass.classLoader!!.getResource("commerce-flow.json")!!.readText()).jsonObject
        val decoder=Json {ignoreUnknownKeys=true};val old=fixture.getValue("detail").jsonObject
        assertNull(decoder.decodeFromJsonElement<CustomerOrderDetail>(old).items)
        val detail=JsonObject(old+("order" to JsonObject(old.getValue("order").jsonObject+mapOf("gift_message" to JsonPrimitive("Happy birthday"),"subtotal" to JsonPrimitive("25.00"))))+("items" to Json.parseToJsonElement("""[{"product_id":"$other","name":"Apples","quantity":2,"price":"12.50","line_total":"25.00","discount_amount":"2.00","unit":"kg"}]""")))
        val current=decoder.decodeFromJsonElement<CustomerOrderDetail>(detail)
        assertEquals("Happy birthday",current.order.gift_message);assertEquals("2.00",current.items?.first()?.discount_amount);assertEquals(2,current.items?.first()?.quantity)
    }
    @Test fun comparisonSelectionFactsAndReset()=runTest {
        val store=ComparisonStore();(0..5).forEach{store.toggle("90000000-0000-4000-8000-00000000000$it")}
        store.toggle("invalid");assertEquals(5,store.state.value.ids.size);assertTrue(store.prompt.contains("/products/"))
        assertEquals("No",ComparisonStore.value(JsonPrimitive(false),"en"));assertEquals("Not provided",ComparisonStore.value(JsonObject(emptyMap()),"en"))
        store.load {throw java.io.IOException("missing")};assertEquals(5,store.state.value.failed.size)
        val fixture=Json.parseToJsonElement(javaClass.classLoader!!.getResource("commerce-flow.json")!!.readText()).jsonObject
        val p=fixtureJson.decodeFromJsonElement<Product>(fixture.getValue("product"))
        store.load {store.reset();p};assertTrue(store.state.value.products.isEmpty());assertTrue(store.state.value.ids.isEmpty())
    }
    @Test fun reviewUnknownOutcomeRequiresReadbackAndRetainsDraft()=runTest {
        val review="""{"id":"$other","display_name":"Mona","rating":4,"title":"Fresh","body":"Good quality","created_at":"2026-10-13T00:00:00Z","status":"pending","version":1}"""
        val transport=CommerceTransport(listOf(auth(),response("[]"),response("null"),response("""{"error":"lost reply"}""",503),response("[]"),response(review),response(review),response("""{"error":"refresh failed"}""",503)))
        val client=CommerceClient(identity(),MemoryCredential(),MemoryCredential(),transport);client.login("fixture","test")
        val store=ReviewsStore(client);store.open(other,true)
        val input=ReviewInput("Mona",4,"Fresh","Good quality");store.edit(input)
        try {store.submit(false);fail()}catch(_:CommerceFailure){}
        try {store.submit(true);fail()}catch(_:CommerceFailure){}
        assertTrue(store.state.value.uncertain)
        try {store.submit(true);fail()}catch(_:CommerceFailure){}
        store.load(true,50);assertEquals(50,store.state.value.offset);assertEquals(input,store.state.value.draft);assertEquals("pending",store.state.value.own?.status);assertFalse(store.state.value.uncertain)
        val writes=transport.requests.filter{it.method=="PUT"};assertEquals(1,writes.size);assertEquals("Bearer customer-access",writes.single().headers["Authorization"])
        assertEquals(input,Json.decodeFromString<ReviewInput>(writes.single().body!!))
        store.submit(true);assertTrue(store.state.value.submitted);assertFalse(store.state.value.uncertain);assertTrue(store.state.value.failed)
        assertFalse(input.copy(display_name="ع".repeat(41)).valid);store.reset();assertNull(store.state.value.own)
    }
    @Test fun relationshipsUseCustomerDeliveryAndLocaleAndValidateBounds()=runTest {
        val transport=CommerceTransport(listOf(auth(),response("[]")))
        val client=CommerceClient(identity(),MemoryCredential(),MemoryCredential(),transport)
        client.login("fixture","test");client.setDelivery(DeliveryPin(30.0,31.0))
        client.relationships(listOf(other,other),"cross_sell","ar")
        try {client.relationships(emptyList(),"related","en");fail()}catch(_:IllegalArgumentException){}
        try {client.relationships(List(51){other},"related","en");fail()}catch(_:IllegalArgumentException){}
        assertEquals(2,transport.requests.size);val request=transport.requests[1]
        assertEquals("Bearer customer-access",request.headers["Authorization"]);assertEquals("30.0",request.headers["X-Delivery-Latitude"]);assertEquals("ar",request.headers["X-Storefront-Locale"])
        assertTrue(request.url.endsWith("sources=$other&kind=cross_sell"))
    }
    @Test fun reorderRecoversLostApplyWithoutRepeatingMutation() = runTest {
        val fixture = Json.parseToJsonElement(javaClass.classLoader!!.getResource("commerce-flow.json")!!.readText()).jsonObject
        val order = fixtureJson.decodeFromJsonElement<CustomerOrder>(fixture.getValue("order"))
        val location=fixture.getValue("location").jsonObject.getValue("id").jsonPrimitive.content
        val proposal="""{"id":"$other","can_apply":true,"applied":false,"expires_at":"2099-01-01T00:00:00Z"}"""
        val context="""{"task_revision":3,"source_revision":7}"""
        val transport=CommerceTransport(listOf(auth(),response(fixture.getValue("cart").toString()),response(fixture.getValue("locations").toString()),response(context),response(fixture.getValue("locations").toString()),response(fixture.getValue("cart").toString()),response(context),response(proposal),response(proposal),response(),response("""{"error":"reply lost"}""",503),response(fixture.getValue("cart").toString()),response(fixture.getValue("locations").toString()),response("""{"proposal_id":"$other"}"""),response("""{"id":"$other","applied":true}""")))
        val storage=MemoryCredential()
        val client=CommerceClient(identity(),MemoryCredential(),MemoryCredential(),transport,reorders=storage)
        client.login("fixture","test")
        val store=ReorderStore(client,CheckoutFlow()) {}
        store.start(order);store.prepare(location,false)
        try {store.approve();fail("Expected lost response")}catch(_:CommerceFailure){}
        assertTrue(store.state.value.pending);assertTrue(client.reorderTask(order.id).pending)
        val restarted=ReorderStore(client,CheckoutFlow()) {};restarted.start(order);assertTrue(restarted.state.value.done)
        assertEquals(1,transport.requests.count {it.url.endsWith("/apply")})
        assertFalse(transport.requests.any {it.url.contains("/checkout/") || it.url.contains("/cart/items")})
        val body=Json.parseToJsonElement(transport.requests.first {it.url.endsWith("/proposals")}.body!!).jsonObject
        assertEquals("buy_again",body["mode"]!!.jsonPrimitive.content);assertEquals(7,body["source_revision"]!!.jsonPrimitive.int)
        assertEquals(3,body["task_revision"]!!.jsonPrimitive.int);assertEquals(location,body["location_id"]!!.jsonPrimitive.content)
    }
    @Test fun reorderTaskPersistsAcrossClientsAndRejectsCorruptStorage()=runTest {
        val storage=MemoryCredential()
        val first=CommerceClient(identity(),MemoryCredential(),MemoryCredential(),CommerceTransport(listOf(auth())),reorders=storage)
        first.login("fixture","test");val task=first.reorderTask(other);first.saveReorderTask(other,task.copy(pending=true))
        val next=CommerceClient(identity(),MemoryCredential(),MemoryCredential(),CommerceTransport(listOf(auth())),reorders=storage)
        next.login("fixture","test");assertEquals(task.copy(pending=true),next.reorderTask(other))
        storage.value="corrupt"
        try {next.reorderTask(other);fail("Must not invent a new task")}catch(_:Exception){}
        assertEquals("corrupt",storage.value)
    }
    @Test fun giftMessageQuoteContractAndByteLimit() = runTest {
        val fixture = Json.parseToJsonElement(javaClass.classLoader!!.getResource("commerce-flow.json")!!.readText()).jsonObject
        val transport = CommerceTransport(listOf(auth(), response(fixture.getValue("quote").toString())))
        val client = CommerceClient(identity(), MemoryCredential(), MemoryCredential(), transport)
        client.login("fixture@example.test", "test")
        client.quote(other, "Happy birthday")
        try { client.quote(other, "ع".repeat(251)); fail() } catch (_: CommerceFailure) {}
        assertEquals(2, transport.requests.size)
        assertTrue(transport.requests[1].url.endsWith("/v1/customer/checkout/quote"))
        val payload = Json.parseToJsonElement(transport.requests[1].body!!).jsonObject
        assertEquals("Happy birthday", payload["gift_message"]!!.jsonPrimitive.content)
        assertEquals(other, payload["location_id"]!!.jsonPrimitive.content)
    }
    @Test fun cartCouponsUseServerAmountsAndAuthenticatedEndpoint()=runTest {
        val base="""{"id":"00000000-0000-0000-0000-000000000001","items":[],"subtotal":"25.00","currency":"EGP","fully_reserved":true}"""
        val discount=base.dropLast(1)+""","discount_amount":"2.50","coupon_code":"REALCODE"}"""
        val transport=CommerceTransport(listOf(auth(),response(discount),response(base),response("""{"error":"Not eligible"}""",422)))
        val client=CommerceClient(identity(),MemoryCredential(),MemoryCredential(),transport)
        client.login("fixture@example.test","test")
        val applied=client.coupon(" REALCODE ")
        assertEquals("REALCODE",applied.coupon_code);assertEquals(0,applied.itemsTotal.toBigDecimal().compareTo("22.50".toBigDecimal()))
        val removed=client.coupon("");assertNull(removed.coupon_code);assertEquals(0,removed.itemsTotal.toBigDecimal().compareTo("25".toBigDecimal()))
        try {client.coupon("BAD");fail("Expected rejection")}catch(e:CommerceFailure){assertEquals(422,e.status)}
        transport.requests.drop(1).forEach {assertEquals("PUT",it.method);assertTrue(it.url.endsWith("/v1/cart/coupon"));assertEquals("Bearer customer-access",it.headers["Authorization"])}
        assertEquals("REALCODE",Json.parseToJsonElement(transport.requests[1].body!!).jsonObject["code"]!!.jsonPrimitive.content)
        assertEquals("",Json.parseToJsonElement(transport.requests[2].body!!).jsonObject["code"]!!.jsonPrimitive.content)
    }

    @Test fun pushRegistrationIsAuthenticatedAndOwnerBound()=runTest {
        val id="00000000-0000-0000-0000-000000000003"
        val transport=CommerceTransport(listOf(auth(),response(),response()))
        val client=CommerceClient(identity(),MemoryCredential(),MemoryCredential(),transport)
        client.login("fixture@example.test","test"); client.setLocale("ar")
        client.registerPushDevice(id,"com.rocento.grocery","test-token",id); client.unregisterPushDevice(id)
        assertEquals(listOf("PUT","DELETE"),transport.requests.drop(1).map{it.method})
        assertTrue(transport.requests[1].url.endsWith("/v1/customer/push-devices/$id"))
        assertEquals("Bearer customer-access",transport.requests[1].headers["Authorization"])
        val body=Json.parseToJsonElement(transport.requests[1].body!!).jsonObject
        assertEquals(id,body["customer_id"]!!.jsonPrimitive.content); assertEquals("android",body["platform"]!!.jsonPrimitive.content); assertEquals("ar",body["locale"]!!.jsonPrimitive.content)
        try {client.unregisterPushDevice("../other");fail("Expected invalid ID")}catch(_:CommerceFailure){}
        assertEquals(3,transport.requests.size)
    }

    @Test fun wishlistUsesAuthenticatedIdempotentEndpoints() = runTest {
        val id="00000000-0000-0000-0000-000000000003"
        val transport=CommerceTransport(listOf(auth(),response("[\"$id\"]"),response(),response(),response("{\"error\":\"unavailable\"}",503)))
        val client=CommerceClient(identity(),MemoryCredential(),MemoryCredential(),transport)
        client.login("fixture@example.test","test")
        assertEquals(listOf(id),client.wishlist());client.saveProduct(id,true);client.saveProduct(id,false)
        try { client.saveProduct(id,true);fail("Expected server failure") } catch(e:CommerceFailure) {assertEquals(503,e.status)}
        assertEquals(listOf("GET","PUT","DELETE","PUT"),transport.requests.drop(1).map{it.method})
        assertTrue(transport.requests[1].url.endsWith("/v1/customer/wishlist"))
        assertTrue(transport.requests[2].url.endsWith("/v1/customer/wishlist/$id"))
        transport.requests.drop(1).forEach{assertEquals("Bearer customer-access",it.headers["Authorization"])}
    }
    @Test fun categoryBrowseUsesScopedServerFilters() = runTest {
        val transport = CommerceTransport(listOf(response("""{"hits":[],"total":0,"facets":{}}""")))
        val client = CommerceClient(identity(), MemoryCredential(), MemoryCredential(), transport)
        val filters = CatalogFilters(query="pear & apple", minimum="2", maximum="9", inStock=true, sort="price_desc", attributes=mapOf("organic" to listOf("true")), attributeTypes=mapOf("organic" to "boolean"))
        assertEquals(0, client.browse(other, filters, 24, "ar").total)
        val query = java.net.URI(transport.requests.single().url).rawQuery.split("&").associate { val parts=it.split("=",limit=2); parts[0] to java.net.URLDecoder.decode(parts[1], "UTF-8") }
        assertEquals(other, query["category_id"]); assertEquals("pear & apple", query["q"])
        assertEquals("24", query["offset"]); assertEquals("2", query["min_price"]); assertEquals("desc", query["sort_order"])
        assertEquals("""{"organic":[true]}""", query["attribute_filters"])
        assertFalse(filters.copy(minimum="10").valid); assertFalse(filters.copy(minimum="NaN").valid)
    }

    @Test fun globalSearchOmitsCategoryAndPreservesQueryAndPaging()=runTest {
        val transport=CommerceTransport(listOf(response("""{"hits":[],"total":0,"facets":{}}""")))
        val client=CommerceClient(identity(),MemoryCredential(),MemoryCredential(),transport)
        client.browse("",CatalogFilters(query="pear & apple"),24,"ar")
        val request=transport.requests.single()
        val query=java.net.URI(request.url).rawQuery
        assertFalse(query.contains("category_id"))
        assertTrue(query.contains("offset=24"))
        assertTrue(java.net.URLDecoder.decode(query,"UTF-8").contains("q=pear & apple"))
        assertEquals("ar",request.headers["X-Storefront-Locale"])
    }
    private val customer="00000000-0000-0000-0000-000000000001"
    private val quoteID="00000000-0000-0000-0000-000000000002"
    private val other="00000000-0000-0000-0000-000000000003"
    private val refresh="a".repeat(64)
    private fun identity()=AppIdentity(customer,"production","https://grocery.example.test/api")
    private fun response(body:String="{}",status:Int=200,headers:Map<String,String> = emptyMap())=Result.success(HTTPResult(status,headers,body.toByteArray()))
    private fun auth(token:String="customer-access",id:String=customer)=response("""{"customer":{"id":"$id","primary_identifier":"email","email":"fixture@example.test","verified":true},"access_token":"$token"}""",headers=mapOf("Set-Cookie" to "customer_refresh=$refresh; HttpOnly; Secure; Path=/, guest_cart=; Max-Age=0, assistant_guest=; Max-Age=0"))
    private fun quote(id:String=quoteID)=CommerceQuote(id,"2030-01-01T00:00:00Z",CommerceQuote.Snapshot("25.00","0.00","5.00","0.00","30.00","EGP","cash_on_delivery"))
    private fun order()=response("""{"order":{"id":"$other","number":42,"status":"placed","total":"30.00","currency":"EGP","created_at":"2026-10-11T00:00:00Z"},"history":[]}""")
    @Test fun refreshRotationAndCredentialBoundaries()=runTest {
        val transport=CommerceTransport(listOf(auth(),response("""{"error":"expired"}""",401),auth("rotated-access"),response("[]"),response("[]")))
        val store=MemoryCredential();val client=CommerceClient(identity(),store,MemoryCredential(),transport)
        client.login("fixture@example.test","test-only-password");client.orders();client.categories("ar")
        val requests=transport.requests
        assertEquals(listOf("/api/v1/customer/auth/login","/api/v1/customer/orders","/api/v1/customer/auth/refresh","/api/v1/customer/orders","/api/v1/catalog/categories"),requests.map{java.net.URI(it.url).path})
        assertNull(requests[0].headers["Authorization"])
        assertEquals("customer_refresh=$refresh",requests[2].headers["Cookie"]);assertNull(requests[2].headers["Authorization"])
        assertEquals("Bearer rotated-access",requests[3].headers["Authorization"])
        assertNull(requests[4].headers["Authorization"]);assertNull(requests[4].headers["Cookie"]);assertEquals("ar",requests[4].headers["X-Storefront-Locale"])
        assertTrue(requests.all{java.net.URI(it.url).host=="grocery.example.test" && it.headers["X-Commerce-Request"]=="1"});assertEquals(refresh,store.read())
    }
    @Test fun checkoutRetrySurvivesRestartLogoutAndAnotherCustomer()=runTest {
        val transport=CommerceTransport(listOf(auth(),Result.failure(IOException("timeout")),response(),auth(id=other),response(),auth(),order()))
        val credentials=MemoryCredential();val attempts=MemoryCredential();var client=CommerceClient(identity(),credentials,attempts,transport)
        client.login("fixture@example.test","test")
        try{client.place(quote());fail("expected timeout")}catch(_:IOException){}
        val pending=client.pendingCheckout();assertNotNull(pending)
        try{client.place(quote(other));fail("different quote must be blocked")}catch(e:CommerceFailure){assertEquals(409,e.status)}
        client.logout();client=CommerceClient(identity(),credentials,attempts,transport)
        client.login("other@example.test","test");assertNull(client.pendingCheckout());client.logout()
        client.login("fixture@example.test","test");assertEquals(pending?.key,client.pendingCheckout()?.key)
        assertEquals(42L,client.place(quote()).order.number);assertNull(attempts.read())
        val requests=transport.requests.filter{it.url.endsWith("checkout/place")};assertEquals(2,requests.size)
        assertEquals(Json.parseToJsonElement(requests[0].body!!),Json.parseToJsonElement(requests[1].body!!))
    }
    @Test fun definitiveRejectionAllowsReviewButServerFailureDoesNot()=runTest {
        val transport=CommerceTransport(listOf(auth(),response("""{"error":"Review expired"}""",400),response("""{"error":"busy"}""",503)))
        val client=CommerceClient(identity(),MemoryCredential(),MemoryCredential(),transport);client.login("fixture@example.test","test")
        try{client.place(quote());fail()}catch(e:CommerceFailure){assertEquals(400,e.status)}
        assertNull(client.pendingCheckout())
        try{client.place(quote(other));fail()}catch(e:CommerceFailure){assertEquals(503,e.status)}
        assertEquals(other,client.pendingCheckout()?.quote?.id)
    }
    @Test fun expiredRefreshClearsCredentialWithoutLeakingToCatalog()=runTest {
        val store=MemoryCredential(refresh);val transport=CommerceTransport(listOf(response("",204),response("[]")));val client=CommerceClient(identity(),store,MemoryCredential(),transport)
        try{client.restore();fail()}catch(e:CommerceFailure){assertEquals(401,e.status)}
        assertNull(store.read());client.categories("en");assertNull(transport.requests.last().headers["Cookie"])
    }
    @Test fun newPasswordLoginRestoresAcrossFreshClientsAndRefreshRotation()=runTest {
        val rotated="b".repeat(64)
        val rotatedAuth=auth("restored-access").getOrThrow().copy(headers=mapOf("Set-Cookie" to "customer_refresh=$rotated; Secure; HttpOnly"))
        val transport=CommerceTransport(listOf(auth(),Result.success(rotatedAuth),auth("second-restart")))
        val storage=MemoryCredential()
        CommerceClient(identity(),storage,MemoryCredential(),transport).login("fixture@example.test","new-test-only-password")
        val restored=CommerceClient(identity(),storage,MemoryCredential(),transport).restore()
        assertEquals("fixture@example.test",restored.identifier)
        assertTrue(restored.verified)
        assertEquals(rotated,storage.read())
        CommerceClient(identity(),storage,MemoryCredential(),transport).restore()
        assertEquals(listOf("customer_refresh=$refresh","customer_refresh=$rotated"),transport.requests.drop(1).map{it.headers["Cookie"]})
        assertTrue(transport.requests.drop(1).all{it.body==null && it.headers["Authorization"]==null && it.url.endsWith("auth/refresh")})
    }
    @Test fun offlineRestartPreservesCredentialForRetry()=runTest {
        val storage=MemoryCredential(refresh)
        val transport=CommerceTransport(listOf(Result.failure(IOException("offline")),auth()))
        val client=CommerceClient(identity(),storage,MemoryCredential(),transport)
        try{client.restore();fail("expected offline failure")}catch(_:IOException){}
        assertEquals(refresh,storage.read())
        assertTrue(client.restore().verified)
    }
    @Test fun revokedSessionCanBeReplacedByNewPasswordLoginAndRestored()=runTest {
        val storage=MemoryCredential("revoked".repeat(10))
        val transport=CommerceTransport(listOf(response("",401),auth(),auth()))
        val client=CommerceClient(identity(),storage,MemoryCredential(),transport)
        try{client.restore();fail("expected revoked session")}catch(e:CommerceFailure){assertEquals(401,e.status)}
        assertNull(storage.read())
        client.login("fixture@example.test","new-test-only-password")
        assertTrue(CommerceClient(identity(),storage,MemoryCredential(),transport).restore().verified)
        assertEquals("customer_refresh=$refresh",transport.requests.last().headers["Cookie"])
    }
    @Test fun deliveryAndIdentifiersFailClosed()=runTest {
        assertThrows(IllegalArgumentException::class.java){DeliveryPin(Double.NaN,0.0)};assertThrows(IllegalArgumentException::class.java){DeliveryPin(91.0,0.0)}
        val transport=CommerceTransport(listOf(response("""{"configured":true,"deliverable":false}""")));val client=CommerceClient(identity(),MemoryCredential(),MemoryCredential(),transport)
        assertFalse(client.coverage(DeliveryPin(30.0,31.0)).deliverable)
        try{client.order("../foreign");fail()}catch(e:CommerceFailure){assertEquals(422,e.status)}
        assertThrows(CommerceFailure::class.java){client.imageURL("https://foreign.example/image")}
        assertEquals(1,transport.requests.size);assertEquals("30.0",transport.requests[0].headers["X-Delivery-Latitude"])
    }
    @Test fun catalogVariantCartDeliveryQuoteAndOrderContract()=runTest {
        val f=Json.parseToJsonElement(javaClass.classLoader!!.getResourceAsStream("commerce-flow.json")!!.bufferedReader().readText()).jsonObject
        val ids=f["ids"]!!.jsonObject
        fun part(name:String)=response(f[name]!!.toString())
        val transport=CommerceTransport(listOf(response(f["auth"]!!.toString(),headers=mapOf("Set-Cookie" to "customer_refresh=$refresh; Secure")),part("categories"),response(buildJsonObject{put("hits",JsonArray(listOf(f["product"]!!)))}.toString()),part("family"),part("empty_cart"),part("cart"),part("coverage"),part("location"),part("availability"),part("options"),part("plan"),part("quote"),part("detail"),response(JsonArray(listOf(f["order"]!!)).toString()),part("detail")))
        val client=CommerceClient(identity(),MemoryCredential(),MemoryCredential(),transport)
        client.login("native-fixture@example.test","test-only-password")
        client.setDelivery(DeliveryPin(30.0,31.0))
        val categories=client.categories("ar");val products=client.products(categories[0].id,"ar");val family=client.family(products[0].id)
        assertEquals("25.00",client.add(family.children[0].id).subtotal)
        val pin=DeliveryPin(30.0,31.0);assertTrue(client.coverage(pin).deliverable)
        val geography=mapOf("country_code" to "EG","state_code" to "11","state_name" to "Cairo","city_id" to "360630","city_name" to "Cairo")
        val location=client.saveLocation(pin,"Fixture delivery street","1","2","3","","neighborhood",geography);client.setDelivery(pin)
        assertEquals(true,client.fulfillment().methods[0].asap)
        assertEquals(1,client.deliveryOptions("delivery",location.id,null,"2026-10-11",true).groups.size)
        client.reserveDelivery("delivery",location.id,null,"2026-10-11",true,emptyList(),java.util.UUID.randomUUID().toString())
        val quote=client.quote(location.id);assertEquals("30.00",quote.snapshot.total)
        assertFalse(transport.requests.any{it.url.endsWith("checkout/place")})
        assertEquals(42L,client.place(quote).order.number)
        val orders=client.orders();assertEquals("placed",client.order(orders[0].id).history[0].status)
        val requests=transport.requests
        val savedAddress=Json.parseToJsonElement(requests[7].body!!).jsonObject
        assertEquals("neighborhood",savedAddress["location_method"]!!.jsonPrimitive.content)
        assertEquals("360630",savedAddress["geography"]!!.jsonObject["city_id"]!!.jsonPrimitive.content)
        assertEquals(ids["variant"],Json.parseToJsonElement(requests[5].body!!).jsonObject["product_id"])
        assertEquals(ids["location"],Json.parseToJsonElement(requests[10].body!!).jsonObject["request"]!!.jsonObject["location_id"])
        assertEquals("30.0",requests[11].headers["X-Delivery-Latitude"])
    }
    @Test fun analyticsRequiresConsentAndNeverCarriesCommerceIdentity()=runTest {
        val transport=CommerceTransport(listOf(response(),response()));val storage=MemoryCredential();val analytics=CommerceAnalytics(identity(),storage,transport)
        analytics.record(CommerceEvent.HOME);assertTrue(transport.requests.isEmpty())
        analytics.consent(true);analytics.record(CommerceEvent.PRODUCT);analytics.record(CommerceEvent.ORDERED)
        analytics.consent(false);analytics.record(CommerceEvent.HOME)
        assertEquals(2,transport.requests.size);assertNull(storage.read())
        transport.requests.forEach {r->
            assertNull(r.headers["Authorization"]);assertNull(r.headers["X-Delivery-Latitude"])
            assertEquals(setOf("id","session_id","event_type","path","source"),Json.parseToJsonElement(r.body!!).jsonObject.keys)
            assertFalse(r.body.contains(customer))
        }
    }

}
