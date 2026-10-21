package com.rocento.mobile

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*

interface NotificationPreferences {
    var orderUpdates: Boolean
    fun readIDs(owner: String): Set<String>
    fun setReadIDs(ids: Set<String>, owner: String)
}
class MemoryNotificationPreferences: NotificationPreferences {
    override var orderUpdates=true
    private val read=mutableMapOf<String,Set<String>>()
    override fun readIDs(owner: String)=read[owner].orEmpty()
    override fun setReadIDs(ids: Set<String>, owner: String) { read[owner]=ids }
}
data class InboxUpdate(val id:String,val order:String,val number:Long,val status:String,val date:String)
data class NotificationsState(val owner: String? = null, val details: List<CustomerOrderDetail> = emptyList(), val read: Set<String> = emptySet(), val enabled: Boolean = true, val unreadOnly: Boolean = false, val loading: Boolean = false, val loaded: Boolean = false, val failed: Boolean = false, val offset: Int = 0, val hasMore: Boolean = false) {
    val events get() = details.flatMap { detail -> detail.history.map { InboxUpdate("${detail.order.id}:${it.id}",detail.order.id,detail.order.number,it.status,it.created_at) } }.distinctBy{it.id}.sortedWith(compareByDescending<InboxUpdate>{it.date}.thenBy{it.id})
    val unread get() = events.filter{it.id !in read}
}
class NotificationsStore(private val fetchOrders: suspend (Int) -> List<CustomerOrder>, private val fetchOrder: suspend (String) -> CustomerOrderDetail, private val preferences: NotificationPreferences) {
    constructor(client: CommerceClient, preferences: NotificationPreferences): this({client.orders(it)},{client.order(it)},preferences)
    private val mutableState=MutableStateFlow(NotificationsState(enabled=preferences.orderUpdates))
    val state=mutableState.asStateFlow()
    var onChange: (() -> Unit)? = null
    private var generation=0
    private fun publish(value: NotificationsState) { mutableState.value=value;onChange?.invoke() }
    fun reset() { generation++;publish(NotificationsState(enabled=preferences.orderUpdates)) }
    fun bind(owner: String?) { if(state.value.owner==owner)return;reset();publish(state.value.copy(owner=owner,read=owner?.let{preferences.readIDs(it)}.orEmpty())) }
    fun setEnabled(value: Boolean) { preferences.orderUpdates=value;generation++;publish(state.value.copy(enabled=value,loading=false)) }
    fun filterUnread(value: Boolean) = publish(state.value.copy(unreadOnly=value))
    fun mark(ids: List<String>) {
        val owner=state.value.owner ?: return
        val read=state.value.read+ids.intersect(state.value.events.map{it.id}.toSet())
        preferences.setReadIDs(read,owner);publish(state.value.copy(read=read))
    }
    private suspend fun check(revision: Int) { currentCoroutineContext().ensureActive();if(revision!=generation)throw CancellationException() }
    suspend fun refresh(owner: String, more: Boolean = false) {
        bind(owner);if(!state.value.enabled || more && (!state.value.hasMore || state.value.loading))return
        val revision=++generation;val offset=if(more)state.value.offset else 0
        publish(state.value.copy(loading=true,failed=false))
        try {
            val orders=fetchOrders(offset);check(revision);val details=mutableListOf<CustomerOrderDetail>()
            for(order in orders) { details+=fetchOrder(order.id);check(revision) }
            publish(state.value.copy(details=(if(more)state.value.details+details else details).distinctBy{it.order.id},offset=offset+orders.size,hasMore=orders.isNotEmpty() && offset+orders.size<=9999,loaded=true))
        } catch(e:Exception) { check(revision);publish(state.value.copy(failed=true));throw e }
        finally { if(revision==generation)publish(state.value.copy(loading=false)) }
    }
}
