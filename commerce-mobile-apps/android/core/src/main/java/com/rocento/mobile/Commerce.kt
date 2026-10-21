package com.rocento.mobile

import java.util.UUID
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.*
import kotlinx.serialization.json.*

class CommerceFailure(val status: Int, override val message: String) : Exception(message)
@Serializable data class CustomerAccount(
    val id: String, val primary_identifier: String, val verified: Boolean,
    val email: String? = null, val mobile_number: String? = null,
) {
    val identifier: String get() = when(primary_identifier) {
        "email" -> email.orEmpty()
        "mobile" -> mobile_number.orEmpty()
        else -> ""
    }
}
@Serializable data class CustomerAuth(val customer: CustomerAccount, val access_token: String)
@Serializable data class CommerceCartItem(val product_id: String, val name: String, val quantity: Int, val reserved_quantity: Int, val price: String, val line_total: String, val unit: String? = null, val available: Int? = null)
@Serializable data class CommerceCart(val id: String, val items: List<CommerceCartItem>, val subtotal: String, val currency: String, val fully_reserved: Boolean,
    val discount_amount: String? = null, val coupon_code: String? = null, val coupon_error: String? = null,
) {
    // Delivery and tax belong to the authoritative checkout quote, not this item total.
    val itemsTotal: String get() {
        val subtotal = subtotal.toBigDecimalOrNull() ?: return this.subtotal
        val discount = (discount_amount ?: "0").toBigDecimalOrNull() ?: return this.subtotal
        return (subtotal - discount).max(java.math.BigDecimal.ZERO).toPlainString()
    }
}
@Serializable data class DeliveryPin(val latitude: Double, val longitude: Double) {
    init { require(latitude.isFinite() && longitude.isFinite() && latitude in -90.0..90.0 && longitude in -180.0..180.0) }
}
@Serializable data class DeliveryCoverage(val configured: Boolean, val deliverable: Boolean)
@Serializable data class CustomerLocation(val id: String, val label: String, val latitude: Double, val longitude: Double, val formatted_address: String, val building: String, val floor: String, val apartment: String, val delivery_instructions: String, val is_default: Boolean, val updated_at: String? = null, val location_method: String? = null, val geography: JsonObject? = null)
@Serializable data class CommerceQuote(val id: String, val expires_at: String, val snapshot: Snapshot) {
    @Serializable data class Snapshot(val subtotal: String, val discount_amount: String, val delivery_fee: String, val tax_amount: String, val total: String, val currency: String, val payment_method: String, val gift_message: String? = null)
}
@Serializable data class CustomerOrder(val id: String, val number: Long, val status: String, val total: String, val currency: String, val created_at: String, val gift_message:String?=null,val subtotal:String?=null,val discount_amount:String?=null,val delivery_fee:String?=null,val tax_amount:String?=null)
@Serializable data class CustomerOrderItem(val product_id:String,val name:String,val quantity:Int,val price:String,val line_total:String,val unit:String?=null,val discount_amount:String?=null)
@Serializable data class CustomerOrderDetail(val order: CustomerOrder, val history: List<OrderHistory>,val items:List<CustomerOrderItem>?=null) {
    @Serializable data class OrderHistory(val id: String, val status: String, val created_at: String)
}
@Serializable data class FulfillmentSlot(val schedule_id: String, val source_id: String, val starts_at: String, val ends_at: String, val availability: String) {
    val id get() = "$source_id|$schedule_id|$starts_at"
}
@Serializable data class FulfillmentOptions(val groups: List<Group>) {
    @Serializable data class Group(val source_id: String, val source_name: String, val slots: List<FulfillmentSlot>)
}
@Serializable data class FulfillmentAvailability(val methods: List<Method>) {
    @Serializable data class Method(val type: String, val scheduling: Boolean, val asap: Boolean? = null, val locations: List<Pickup>? = null)
    @Serializable data class Pickup(val id: String, val name: String)
}
@Serializable data class CheckoutAttempt(val customerID: String, val quote: CommerceQuote, val key: String)
interface CredentialStorage { fun read(): String?; fun save(value: String?); fun readChecked(): String? = read() }

/** Customer credentials are scoped to a compiled installation, never remote config URLs. */
class CommerceClient(
    val identity: AppIdentity,
    private val credentials: CredentialStorage,
    private val attempts: CredentialStorage,
    private val transport: HTTPTransport = OkHTTPTransport(),
    private val reorders: CredentialStorage? = null,
) : CatalogServing, AccountServing, CartServing, CheckoutServing, OrderServing {
    private val json = Json { ignoreUnknownKeys = true }
    private val mutex = Mutex()
    private var epoch = 0
    private var token: String? = null
    private var customer: CustomerAccount? = null
    private var locale = "en"
    private var pin: DeliveryPin? = null
    suspend fun setLocale(value: String) = mutex.withLock { locale = if(value == "ar") "ar" else "en" }
    suspend fun setDelivery(value: DeliveryPin?) = mutex.withLock { pin = value }
    private fun identifier(value: String): String {
        if (!value.matches(Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"))) throw CommerceFailure(422,"Invalid resource")
        return value
    }
    private fun element(value: Any?): JsonElement = when(value) {
        null -> JsonNull
        is JsonElement -> value
        is String -> JsonPrimitive(value)
        is Number -> JsonPrimitive(value)
        is Boolean -> JsonPrimitive(value)
        is List<*> -> JsonArray(value.map(::element))
        is Map<*,*> -> JsonObject(value.entries.associate { it.key.toString() to element(it.value) })
        else -> error("Unsupported JSON value")
    }
    private fun body(vararg values: Pair<String,Any?>): String = element(values.toMap()).toString()
    private var supportGuest:String?=null
    private var memoryGuest:String?=null
    private suspend fun raw(path: String, method: String = "GET", body: String? = null, bearer: String? = null, refresh: String? = null, delivery: DeliveryPin? = pin, supportGuest:String?=null,memoryGuest:String?=null): HTTPResult {
        require(path.startsWith("v1/") && !path.contains("..") && !path.contains("://") && !path.contains('#'))
        val headers = mutableMapOf("X-Commerce-Request" to "1", "Content-Type" to "application/json", "X-Storefront-Locale" to locale, "X-Delivery-Context" to "1")
        delivery?.let { headers["X-Delivery-Latitude"] = it.latitude.toString(); headers["X-Delivery-Longitude"] = it.longitude.toString() }
        bearer?.let { headers["Authorization"] = "Bearer $it" }; refresh?.let { headers["Cookie"] = "customer_refresh=$it" }
        supportGuest?.let { headers["Cookie"] = "support_guest=$it" }
        memoryGuest?.let { headers["Cookie"] = "assistant_guest=$it" }
        return transport.request(identity.commerceBase.trimEnd('/')+"/"+path,method,headers,body,2000000)
    }
    private inline fun <reified T> checked(response: HTTPResult): T {
        if (response.status !in 200..299) {
            val text = runCatching { json.parseToJsonElement(response.body.decodeToString()).jsonObject["error"]?.jsonPrimitive?.content }.getOrNull()
            throw CommerceFailure(response.status,(text ?: "Request failed. Please retry.").take(400))
        }
        return json.decodeFromString(response.body.decodeToString())
    }
    private fun refreshCookie(response: HTTPResult): String = Regex("(?:^|,\\s*)customer_refresh=([A-Za-z0-9_-]{32,512})(?:;|$)").find(response.header("set-cookie").orEmpty())?.groupValues?.get(1) ?: throw CommerceFailure(502,"Unable to establish a secure session")
    override suspend fun login(identifier: String, password: String): CustomerAccount = mutex.withLock {
        memoryGuest=null
        epoch++; token = null; customer = null; pin = null; credentials.save(null)
        val response = raw("v1/customer/auth/login","POST",body("identifier" to identifier,"password" to password))
        val auth: CustomerAuth = checked(response); credentials.save(refreshCookie(response)); token = auth.access_token; customer = auth.customer; auth.customer
    }
    private suspend fun restoreRaw(): CustomerAccount {
        val refresh = credentials.readChecked() ?: throw CommerceFailure(401,"Please sign in")
        val response = raw("v1/customer/auth/refresh","POST",refresh=refresh)
        if(response.status in listOf(401,403,204)) { token=null; customer=null; pin=null; credentials.save(null); throw CommerceFailure(401,"Please sign in") }
        val auth: CustomerAuth = checked(response); credentials.save(refreshCookie(response)); token=auth.access_token; customer=auth.customer; return auth.customer
    }
    override suspend fun restore(): CustomerAccount = mutex.withLock { restoreRaw() }
    override suspend fun logout() = mutex.withLock {
        memoryGuest=null
        epoch++; val oldToken=token; val oldRefresh=credentials.readChecked(); token=null; customer=null; pin=null; credentials.save(null)
        try { raw("v1/customer/auth/logout","POST",bearer=oldToken,refresh=oldRefresh) } catch(e:Exception) { if(e is kotlinx.coroutines.CancellationException) throw e }; Unit
    }
    private suspend inline fun <reified T> requestRaw(path: String, method: String = "GET", body: String? = null, authenticated: Boolean = true): T {
        if(authenticated && token == null) restoreRaw()
        var response=raw(path,method,body,if(authenticated) token else null)
        if(authenticated && response.status == 401) { restoreRaw(); response=raw(path,method,body,token) }
        return checked(response)
    }
    private suspend inline fun <reified T> call(path: String, method: String = "GET", body: String? = null, authenticated: Boolean = true): T = mutex.withLock { requestRaw(path,method,body,authenticated) }
    // Public reads snapshot context under the lock, then release it before network IO.
    // Mutations and customer refresh remain serialized by the existing gate.
    private suspend inline fun <reified T> catalogRequest(path: String, language: String): T {
        require(path.startsWith("v1/") && !path.contains("..") && !path.contains("://") && !path.contains('#'))
        val delivery = mutex.withLock { pin }
        val headers = mutableMapOf("X-Commerce-Request" to "1", "Content-Type" to "application/json",
            "X-Storefront-Locale" to (if(language == "ar") "ar" else "en"), "X-Delivery-Context" to "1")
        delivery?.let { headers["X-Delivery-Latitude"] = it.latitude.toString(); headers["X-Delivery-Longitude"] = it.longitude.toString() }
        val response = transport.get(identity.commerceBase.trimEnd('/')+"/"+path, headers, 2000000)
        return kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Default) { checked<T>(response) }
    }
    override suspend fun authAction(action: String, identifier: String, password: String?, code: String?) {
        require(action in listOf("register","request-verification","verify","forgot-password","reset-password"))
        val values=mutableMapOf<String,Any?>("identifier" to identifier); password?.let{ values["password"]=it }; code?.let{values["token"]=it}
        call<JsonObject>("v1/customer/auth/$action","POST",element(values).toString(),false)
        if(action == "reset-password") logout()
    }
    override suspend fun me(): CustomerAccount = mutex.withLock { requestRaw<CustomerAccount>("v1/customer/me").also { customer=it } }
    suspend fun streamAssistant(input:AssistantInput,onEvent:suspend (AssistantEvent)->Unit) {
        require(input.message.isNotBlank() && input.message.codePointCount(0,input.message.length)<=4000 && assistantUUID(input.request_id) && assistantUUID(input.conversation_id))
        require(input.product_id==null || assistantUUID(input.product_id))
        require(input.product_id==null || input.cart_context!=true)
        val revision=mutex.withLock {if(token==null && credentials.readChecked()!=null)restoreRaw();epoch}
        for(attempt in 0..1) {
            val headers=mutex.withLock {
                if(epoch!=revision)throw CommerceFailure(401,"Session changed")
                mutableMapOf("Content-Type" to "application/json","Accept" to "text/event-stream","X-Commerce-Request" to "1","X-Commerce-Assistant-Errors" to "1","X-Commerce-Request-Reference" to input.request_id,"X-Storefront-Locale" to locale,"X-Delivery-Context" to "1").also { h ->
                    token?.let{h["Authorization"]="Bearer $it"}
                    if(token==null)memoryGuest?.let{h["Cookie"]="assistant_guest=$it"}
                    if(!input.personalize)h["X-Commerce-Personalize"]="0"
                    pin?.let {h["X-Delivery-Latitude"]=it.latitude.toString();h["X-Delivery-Longitude"]=it.longitude.toString()}
                }
            }
            val parser=AssistantStreamDecoder(input.request_id)
            try {
                transport.stream(identity.commerceBase.trimEnd('/')+"/v1/assistant/chat",headers,json.encodeToString(input),65536,
                    onResponse={r->
                        if(r.status!=200)throw CommerceFailure(r.status,"Assistant request failed")
                        if(r.header("content-type")?.lowercase()?.startsWith("text/event-stream")!=true)throw AssistantStreamFailure()
                    }, onChunk={bytes->
                        mutex.withLock{if(epoch!=revision)throw CommerceFailure(401,"Session changed")}
                        parser.feed(bytes).forEach{mutex.withLock{if(epoch!=revision)throw CommerceFailure(401,"Session changed")};onEvent(it)};parser.done
                    })
                mutex.withLock{if(epoch!=revision)throw CommerceFailure(401,"Session changed")}
                parser.finish();return
            } catch(e:CommerceFailure) {
                if(e.status!=401 || attempt!=0 || headers["Authorization"]==null)throw e
                mutex.withLock {
                    if(epoch!=revision)throw CommerceFailure(401,"Session changed")
                    if(headers["Authorization"]=="Bearer $token")restoreRaw()
                }
            }
        }
    }
    suspend fun assistantProducts(query:String,locale:String):List<Product> {
        require(query.length<=120)
        setLocale(locale)
        return call<Results>("v1/search?q="+java.net.URLEncoder.encode(query,"UTF-8"),authenticated=false).hits.take(8)
    }
    suspend fun assistantProposal(id:String):JsonObject = call("v1/cart/proposals/${identifier(id)}")
    suspend fun reorderTask(order: String, again: Boolean = false): ReorderTask = mutex.withLock {
        val owner = customer ?: throw CommerceFailure(401,"Please sign in")
        val storage = reorders ?: throw CommerceFailure(500,"Reorder storage is unavailable")
        val saved = storage.readChecked()?.let { json.decodeFromString<Map<String,ReorderTask>>(it).toMutableMap() } ?: mutableMapOf()
        val key = owner.id+":"+identifier(order)
        if (!again && saved[key] != null) return@withLock saved.getValue(key).also { identifier(it.task) }
        val task = ReorderTask(java.util.UUID.randomUUID().toString(),false); saved[key]=task
        storage.save(json.encodeToString(saved)); task
    }
    suspend fun saveReorderTask(order: String, task: ReorderTask) = mutex.withLock {
        val owner = customer ?: throw CommerceFailure(401,"Please sign in")
        val storage = reorders ?: throw CommerceFailure(500,"Reorder storage is unavailable")
        val saved = storage.readChecked()?.let { json.decodeFromString<Map<String,ReorderTask>>(it).toMutableMap() } ?: mutableMapOf()
        saved[owner.id+":"+identifier(order)]=task; storage.save(json.encodeToString(saved))
    }
    suspend fun reorderContext(task:String):JsonObject = call("v1/cart/shopping/${identifier(task)}")
    suspend fun proposeReorder(task:String,order:String,location:String,selections:JsonArray?=null):JsonObject {
        val revision=mutex.withLock { epoch }; val context=reorderContext(task)
        if(revision!=mutex.withLock { epoch })throw CommerceFailure(401,"Session changed")
        val goal=mapOf("purpose" to "Reorder","budget" to null,"currency" to null,"all_inclusive" to false,"budget_exclusive" to false,"people" to null,"locked_products" to emptyList<String>(),"excluded_products" to emptyList<String>(),"locked_brands" to emptyList<String>(),"allow_substitutions" to false,"delivery_date" to null,"assumptions" to emptyList<String>(),"unresolved" to emptyList<String>(),"saving_target" to null)
        return call("v1/cart/proposals","POST",body("task_id" to identifier(task),"task_revision" to context["task_revision"],"source_revision" to context["source_revision"],"mode" to "buy_again","auto_select" to (selections==null),"order_id" to identifier(order),"location_id" to identifier(location),"selections" to (selections ?: JsonArray(emptyList())),"goal" to goal))
    }
    suspend fun applyAssistantProposal(id:String):CommerceCart = mutex.withLock {
        identifier(id)
        requestRaw<JsonObject>("v1/cart/trust/confirm","POST",body("proposal_id" to id,"idempotency_key" to id,"grant_id" to null))
        requestRaw("v1/cart/proposals/$id/apply","POST",body("idempotency_key" to id))
    }
    suspend fun registerPushDevice(id: String, appID: String, token: String, customerID: String) {
        call<JsonObject>("v1/customer/push-devices/${identifier(id)}", "PUT", body("platform" to "android", "app_id" to appID, "token" to token, "locale" to locale, "customer_id" to customerID))
    }
    suspend fun unregisterPushDevice(id: String) { call<JsonObject>("v1/customer/push-devices/${identifier(id)}", "DELETE") }
    suspend fun wishlist(): List<String> = call("v1/customer/wishlist")
    override suspend fun saveProduct(id: String, saved: Boolean) { call<JsonObject>("v1/customer/wishlist/${identifier(id)}", if(saved) "PUT" else "DELETE") }
    override suspend fun cart(): CommerceCart = call("v1/cart","POST")
    override suspend fun add(id: String, quantity: Int): CommerceCart = mutex.withLock { requestRaw<CommerceCart>("v1/cart","POST"); requestRaw("v1/cart/items","POST",body("product_id" to identifier(id),"quantity" to quantity)) }
    override suspend fun quantity(id: String, quantity: Int): CommerceCart = call("v1/cart/items/${identifier(id)}",if(quantity==0) "DELETE" else "PUT",if(quantity==0) null else body("quantity" to quantity))
    suspend fun locations(): List<CustomerLocation> = call("v1/customer/locations")
    suspend fun saveLocation(pin: DeliveryPin,address: String,building: String,floor: String,apartment: String,instructions: String,locationMethod: String = "pin",geography: Map<String,String>? = null): CustomerLocation = call("v1/customer/locations","POST",body("label" to "home","latitude" to pin.latitude,"longitude" to pin.longitude,"formatted_address" to address,"building" to building,"floor" to floor,"apartment" to apartment,"delivery_instructions" to instructions,"is_default" to true,"location_method" to locationMethod,"geography" to geography))
    suspend fun coverage(pin: DeliveryPin): DeliveryCoverage = mutex.withLock { checked(raw("v1/delivery-area",delivery=pin)) }
    override suspend fun coupon(code: String): CommerceCart = call("v1/cart/coupon","PUT",body("code" to code.trim()))
    suspend fun fulfillment(): FulfillmentAvailability = call("v1/fulfillment/availability")
    private fun fulfillmentBody(method: String,location: String?,source: String?,date: String,asap: Boolean) = mapOf("method" to method,"location_id" to location,"source_id" to source,"date" to date,"asap" to asap)
    override suspend fun deliveryOptions(method: String,location: String?,source: String?,date: String,asap: Boolean): FulfillmentOptions = call("v1/fulfillment/plan-options","POST",element(fulfillmentBody(method,location,source,date,asap)).toString())
    override suspend fun reserveDelivery(method: String,location: String?,source: String?,date: String,asap: Boolean,windows: List<FulfillmentSlot>,key: String) {
        call<JsonObject>("v1/fulfillment/plans","POST",body("request" to fulfillmentBody(method,location,source,date,asap),"windows" to windows.map { mapOf("source_id" to it.source_id,"schedule_id" to it.schedule_id,"starts_at" to it.starts_at,"ends_at" to it.ends_at) },"idempotency_key" to key))
    }
    override suspend fun quote(location: String?, giftMessage: String): CommerceQuote {
        if (giftMessage.toByteArray(Charsets.UTF_8).size > 500) throw CommerceFailure(422, "Please shorten your gift message")
        return call("v1/customer/checkout/quote","POST",body("location_id" to location,"gift_message" to giftMessage))
    }
    private fun savedAttempts(): MutableMap<String, CheckoutAttempt> = attempts.readChecked()?.let { json.decodeFromString<Map<String, CheckoutAttempt>>(it).toMutableMap() } ?: mutableMapOf()
    private fun saveAttempt(attempt: CheckoutAttempt?, customerID: String) {
        val all=savedAttempts(); if(attempt==null) all.remove(customerID) else all[customerID]=attempt
        attempts.save(if(all.isEmpty()) null else json.encodeToString(all))
    }
    private fun pendingRaw(): CheckoutAttempt? = customer?.let { savedAttempts()[it.id] }
    override suspend fun pendingCheckout(): CheckoutAttempt? = mutex.withLock { pendingRaw() }
    override suspend fun place(quote: CommerceQuote): CustomerOrderDetail = mutex.withLock {
        val customer=customer ?: throw CommerceFailure(401,"Please sign in")
        val pending=pendingRaw()
        if(pending != null && pending.quote.id != quote.id) throw CommerceFailure(409,"Resolve the previous checkout attempt before placing another order")
        val attempt=pending ?: CheckoutAttempt(customer.id,quote,UUID.randomUUID().toString())
        saveAttempt(attempt,customer.id)
        // Persist before sending, including across logout, expired sessions and process restarts.
        try {
            requestRaw<CustomerOrderDetail>("v1/customer/checkout/place","POST",body("quote_id" to quote.id,"idempotency_key" to attempt.key)).also { saveAttempt(null,customer.id) }
        } catch(e:CommerceFailure) {
            // The server resolves an existing key before validation; 400 cannot have committed.
            if(e.status==400) saveAttempt(null,customer.id)
            throw e
        }
    }
    override suspend fun orders(offset: Int): List<CustomerOrder> = call("v1/customer/orders?offset=${offset.coerceAtLeast(0)}")
    override suspend fun order(id: String): CustomerOrderDetail = call("v1/customer/orders/${identifier(id)}")
    override suspend fun categories(locale: String): List<Category> = catalogRequest("v1/catalog/categories",locale)
    @Serializable private data class Results(val hits: List<Product>)
    override suspend fun products(category: String?,locale: String): List<Product> {
        if(category?.startsWith("demo-feed-")==true) return CommerceCatalog(identity,transport).products(category,locale)
        val id=category?.let { if(it.matches(Regex("[0-9a-fA-F-]{36}"))) identifier(it) else categories(locale).firstOrNull { c->c.slug==it }?.id ?: return emptyList() }
        return catalogRequest<Results>("v1/search?q="+(id?.let { "&category_id=$it" } ?: ""),locale).hits
    }
    override suspend fun attributes(locale: String): List<CatalogAttribute> = catalogRequest("v1/catalog/attribute-definitions",locale)
    override suspend fun browse(category: String, filters: CatalogFilters, offset: Int, locale: String): CatalogPage {
        require(filters.valid)
        val id = if (category.isEmpty()) "" else if (category.matches(Regex("[0-9a-fA-F-]{36}"))) identifier(category) else categories(locale).firstOrNull { it.slug == category }?.id ?: throw MobileFailure("Unknown category")
        return catalogRequest("v1/search?" + filters.parameters(id, offset),locale)
    }
    override suspend fun product(id: String,locale: String): Product = catalogRequest("v1/catalog/products/${identifier(id)}",locale)
    suspend fun family(id: String): ProductFamily = call("v1/catalog/products/${identifier(id)}/family",authenticated=false)
    suspend fun reviews(id:String,offset:Int=0):List<ProductReview> = call("v1/products/${identifier(id)}/reviews?offset=${offset.coerceAtLeast(0)}",authenticated=false)
    suspend fun supportTickets():List<SupportTicket> = call("v1/customer/support/tickets")
    suspend fun assistantHistory(id:String?=null):List<HistoryTurn>{val turns:List<HistoryTurn> = call("v1/assistant/history"+(id?.let{"?conversation_id=${identifier(it)}"} ?: ""));validateHistory(turns);return turns}
    private suspend inline fun <reified T> memoryRequest(path:String,method:String="GET",body:String?=null):T = mutex.withLock {
        if(customer==null && credentials.readChecked()!=null)restoreRaw()
        if(customer!=null)return@withLock requestRaw(path,method,body)
        val response=raw(path,method,body,memoryGuest=memoryGuest);val value:T=checked(response)
        val header=response.header("set-cookie").orEmpty();val cookie=Regex("(?:^|,\\s*)assistant_guest=([A-Za-z0-9]{48})(?:;|$)").find(header)?.groupValues?.get(1)
        if(cookie!=null)memoryGuest=cookie else if(header.contains("assistant_guest=;"))memoryGuest=null
        value
    }
    suspend fun memoryView(id:String):MemoryView {
        val value:MemoryView=memoryRequest("v1/assistant/memory?conversation_id=${identifier(id)}")
        if(value.enabled && value.guest && memoryGuest==null)throw CommerceFailure(503,"Guest memory session unavailable")
        return value
    }
    suspend fun savedGoals():List<SavedGoal>{val result:JsonObject=call("v1/cart/saved-goals");return json.decodeFromJsonElement(result.getValue("goals"))}
    suspend fun exportMemory():JsonObject=memoryRequest("v1/assistant/memory/export")
    suspend fun changeMemory(action:MemoryAction){
        when(action){
            is MemoryAction.Consent->memoryRequest<JsonObject>("v1/assistant/memory","PUT",body("personalized" to action.personalized,"journey" to (action.personalized && action.journey),"expected_version" to action.version))
            is MemoryAction.Preference->{identifier(action.input.category_id);action.input.replaces?.let{identifier(it)};memoryRequest<JsonObject>("v1/assistant/memory/preferences","POST",json.encodeToString(action.input))}
            is MemoryAction.RemovePreference->memoryRequest<JsonObject>("v1/assistant/memory/preferences/${identifier(action.id)}","DELETE")
            is MemoryAction.ClearContext->memoryRequest<JsonObject>("v1/assistant/memory/context/${identifier(action.id)}","DELETE")
            MemoryAction.Delete->memoryRequest<JsonObject>("v1/assistant/memory","DELETE")
            is MemoryAction.Goal->{if(action.name.isBlank() || action.name.codePointCount(0,action.name.length)>100 || action.name.any{it.isISOControl()})throw CommerceFailure(422,"Choose a goal name of 1-100 characters");call<JsonObject>("v1/cart/saved-goals/${identifier(action.goal.task_id)}","PUT",body("name" to action.name,"archived" to action.archived,"expected_version" to action.goal.version))}
            is MemoryAction.DeleteGoal->call<JsonObject>("v1/cart/saved-goals/${identifier(action.goal.task_id)}?version=${action.goal.version}","DELETE")
        }
    }
    suspend fun supportDetail(id:String):SupportDetail = call("v1/customer/support/tickets/${identifier(id)}")
    suspend fun createSupport(input:SupportInput):SupportDetail = mutex.withLock {
        if(!input.valid(customer!=null))throw CommerceFailure(422,"Complete the support form")
        identifier(input.request_id);input.order_id?.let{identifier(it)}
        if(customer!=null)return@withLock requestRaw("v1/support/tickets","POST",json.encodeToString(input))
        if(supportGuest==null){
            val response=raw("v1/support/session","POST");checked<JsonObject>(response)
            supportGuest=Regex("(?:^|,\\s*)support_guest=([A-Za-z0-9]{48})(?:;|$)").find(response.header("set-cookie").orEmpty())?.groupValues?.get(1) ?: throw CommerceFailure(502,"Unable to establish a support session")
        }
        checked(raw("v1/support/tickets","POST",json.encodeToString(input),supportGuest=supportGuest))
    }
    suspend fun replySupport(id:String,requestID:String,message:String):SupportDetail {
        if(!supportTextValid(message,2000))throw CommerceFailure(422,"Enter a message within 2000 bytes")
        return call("v1/customer/support/tickets/${identifier(id)}/messages","POST",body("request_id" to identifier(requestID),"body" to message))
    }
    suspend fun ownReview(id:String):ProductReview? = call("v1/customer/products/${identifier(id)}/review")
    suspend fun submitReview(id:String,input:ReviewInput):ProductReview = mutex.withLock {
        if(customer?.verified!=true || !input.valid)throw CommerceFailure(422,"Verify your account and complete a valid review")
        requestRaw("v1/customer/products/${identifier(id)}/review","PUT",json.encodeToString(input))
    }
    suspend fun relationships(sources:List<String>,kind:String,locale:String):List<Product> = mutex.withLock {
        require(sources.size in 1..50 && kind in listOf("related","upsell","cross_sell"))
        this.locale=locale
        val ids=java.net.URLEncoder.encode(sources.map(::identifier).distinct().sorted().joinToString(","),"UTF-8")
        requestRaw("v1/catalog/relationships?sources=$ids&kind=$kind",authenticated=customer!=null)
    }
    fun imageURL(id: String): String = identity.commerceBase.trimEnd('/')+"/v1/catalog/media/${identifier(id)}/content?width=480"

}
