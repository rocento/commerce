package com.rocento.mobile

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
import java.time.Instant

@Serializable data class ReorderTask(val task: String, val pending: Boolean)
data class ReorderState(val order: CustomerOrder? = null, val cart: CommerceCart? = null, val locations: List<CustomerLocation> = emptyList(), val proposal: JsonObject? = null, val task: ReorderTask? = null, val busy: Boolean = false, val pending: Boolean = false, val done: Boolean = false)
class ReorderStore(private val client: CommerceClient, private val checkout: CheckoutFlow, private val accept: (CommerceCart) -> Unit) {
    private val mutableState = MutableStateFlow(ReorderState())
    val state = mutableState.asStateFlow()
    var onChange: (() -> Unit)? = null
    private var generation = 0
    private fun publish(value: ReorderState) { mutableState.value=value; onChange?.invoke() }
    fun reset() { generation++; publish(ReorderState()) }
    companion object { fun signature(cart:CommerceCart) = cart.items.sortedBy { it.product_id }.map { listOf(it.product_id,it.quantity.toString(),it.price) } }
    private suspend fun check(revision:Int) { currentCoroutineContext().ensureActive(); if(revision!=generation)throw CancellationException("Reorder session changed") }
    private suspend fun work(operation:suspend (Int)->Unit) {
        if(state.value.busy || checkout.state.value.locked)throw CommerceFailure(409,"Resolve the previous checkout first")
        val revision=generation; publish(state.value.copy(busy=true))
        try { operation(revision) } finally { if(revision==generation)publish(state.value.copy(busy=false)) }
    }
    suspend fun start(order:CustomerOrder,again:Boolean=false) {
        if(again && (!state.value.done || state.value.order?.id!=order.id))throw CommerceFailure(409,"Check the previous reorder first")
        work { revision ->
            publish(ReorderState(order=order,busy=true))
            val task=client.reorderTask(order.id,again); check(revision)
            val cart=client.cart(); check(revision)
            val locations=client.locations(); check(revision)
            val context=client.reorderContext(task.task); check(revision)
            val proposal=context.text("proposal_id")?.let { client.assistantProposal(it) }; check(revision)
            if(task.pending && proposal==null)throw CommerceFailure(409,"The previous basket update cannot be confirmed. Retry loading it.")
            val done=proposal.flag("applied")
            publish(state.value.copy(task=task,cart=cart,locations=locations,proposal=proposal,pending=task.pending && !done,done=done)); accept(cart)
        }
    }
    suspend fun prepare(location:String,replace:Boolean) = work { revision ->
        val old=state.value; val order=old.order; val task=old.task; val expected=old.cart
        if(order==null || task==null || expected==null || old.pending || old.done)throw CommerceFailure(409,"Reload the reorder before changing it")
        val address=old.locations.firstOrNull { it.id==location }
        val locations=client.locations(); check(revision); publish(state.value.copy(locations=locations))
        if(address==null || locations.firstOrNull { it.id==location }!=address)throw CommerceFailure(409,"That address changed. Confirm the current address.")
        var latest=client.cart(); check(revision); accept(latest); publish(state.value.copy(cart=latest,proposal=null))
        if(signature(latest)!=signature(expected))throw CommerceFailure(409,"Your cart changed. Review it and choose keep or replace again.")
        if(replace)for(item in expected.items) {
            val observed=client.cart(); check(revision)
            if(signature(observed)!=signature(latest)) { accept(observed); publish(state.value.copy(cart=observed)); throw CommerceFailure(409,"Your cart changed while clearing it. Review the remaining items.") }
            checkout.invalidate()
            try { latest=client.quantity(item.product_id,0); check(revision) }
            catch(e:CancellationException) { throw e }
            catch(e:Exception) { check(revision); val remaining=client.cart(); check(revision); accept(remaining); publish(state.value.copy(cart=remaining)); throw e }
            accept(latest); publish(state.value.copy(cart=latest))
        }
        val proposal=client.proposeReorder(task.task,order.id,location); check(revision); publish(state.value.copy(proposal=proposal))
    }
    suspend fun revise(selections:JsonArray) = work { revision ->
        val p=state.value.proposal; val draft=p?.get("draft") as? JsonObject
        if(draft==null || state.value.done || selections.isEmpty() || selections.any { ((it as? JsonObject)?.get("quantity") as? JsonPrimitive)?.intOrNull !in 1..1000000 })throw CommerceFailure(422,"Choose at least one item with a valid quantity")
        val proposal=client.proposeReorder(draft.text("task_id").orEmpty(),draft.text("order_id").orEmpty(),draft.text("location_id").orEmpty(),selections); check(revision); publish(state.value.copy(proposal=proposal))
        client.saveReorderTask(draft.text("order_id").orEmpty(),ReorderTask(draft.text("task_id").orEmpty(),false)); check(revision); publish(state.value.copy(pending=false))
    }
    suspend fun approve() = work { revision ->
        val order=state.value.order; val task=state.value.task; val id=state.value.proposal.text("id")
        if(order==null || task==null || id==null)throw CommerceFailure(409,"Review a basket first")
        val fresh=client.assistantProposal(id); check(revision); publish(state.value.copy(proposal=fresh))
        if(!fresh.flag("applied")) {
            val verdict=(fresh["execution"] as? JsonObject).text("verdict")
            if(!fresh.flag("can_apply") || !runCatching { Instant.parse(fresh.text("expires_at")).isAfter(Instant.now()) }.getOrDefault(false) || verdict!=null && verdict!="pass")throw CommerceFailure(409,"This proposal needs a fresh review")
            client.saveReorderTask(order.id,task.copy(pending=true)); check(revision); publish(state.value.copy(pending=true)); checkout.invalidate()
            val applied=client.applyAssistantProposal(id); check(revision); accept(applied)
        }
        val cart=client.cart(); check(revision); accept(cart)
        client.saveReorderTask(order.id,task.copy(pending=false)); check(revision); publish(state.value.copy(cart=cart,done=true,pending=false))
    }
}
