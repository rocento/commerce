package com.rocento.mobile

import java.util.UUID
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.*

enum class CommerceEvent(val type:String,val path:String) {
    HOME("page_view","/"), CATALOG("page_view","/categories/native"), PRODUCT("page_view","/products/native"),
    BAG("page_view","/cart"), ADDED("cart_added","/cart"), CHECKOUT("checkout_started","/checkout"), ORDERED("order_placed","/checkout/complete")
}
/** Optional fixed funnel events; no customer, product, order, search or location payloads. */
class CommerceAnalytics(private val identity:AppIdentity,private val storage:CredentialStorage,private val transport:HTTPTransport=OkHTTPTransport()) {
    val initiallyEnabled=storage.read()=="true"
    @Volatile private var enabled=initiallyEnabled
    @Volatile private var session=UUID.randomUUID().toString()
    private var visitor:String?=null
    private val gate=Mutex()
    fun consent(value:Boolean) { storage.save(if(value) "true" else null);enabled=value;if(!value){session=UUID.randomUUID().toString();visitor=null} }
    suspend fun record(event:CommerceEvent) {
        if(!enabled || !gate.tryLock()) return
        try {
            if(!enabled)return
            val currentSession=session
            val headers=mutableMapOf("X-Commerce-Request" to "1","Content-Type" to "application/json")
            visitor?.let{headers["Cookie"]="analytics_visitor=$it"}
            val body=buildJsonObject {put("id",UUID.randomUUID().toString());put("session_id",currentSession);put("event_type",event.type);put("path",event.path);put("source","direct")}.toString()
            val response=transport.request(identity.commerceBase.trimEnd('/')+"/v1/analytics/events","POST",headers,body,16384)
            if(enabled && session==currentSession) visitor=Regex("(?:^|,\\s*)analytics_visitor=([A-Za-z0-9_-]{16,512})(?:;|$)").find(response.header("set-cookie").orEmpty())?.groupValues?.get(1) ?: visitor
        } catch(e:Exception) {if(e is kotlinx.coroutines.CancellationException)throw e} finally {gate.unlock()}
    }
}
