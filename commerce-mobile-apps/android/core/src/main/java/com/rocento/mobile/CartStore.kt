package com.rocento.mobile

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

class CartStore(private val client: CartServing, private val checkout: CheckoutFlow) {
    private val mutableState = MutableStateFlow<CommerceCart?>(null)
    val state = mutableState.asStateFlow()
    var onChange: (() -> Unit)? = null
    private var generation = 0
    private fun publish(value: CommerceCart?) { mutableState.value = value; onChange?.invoke() }
    fun reset() { generation++; publish(null) }
    fun accept(cart: CommerceCart) { checkout.invalidate(); publish(cart) }
    suspend fun refresh() { val revision = generation; val result = client.cart(); checkRevision(revision); publish(result) }
    suspend fun mutate(operation: suspend () -> CommerceCart) {
        if (checkout.state.value.locked) throw CommerceFailure(409,"Resolve the previous checkout first")
        val revision = generation; checkout.invalidate()
        val result = operation(); checkRevision(revision); publish(result)
    }
    suspend fun add(id: String, quantity: Int = 1) {
        if (quantity !in 1..99) throw CommerceFailure(422,"Invalid quantity")
        mutate { client.add(id, quantity) }
    }
    suspend fun quantity(id: String,value: Int) = mutate { client.quantity(id,value) }
    suspend fun coupon(code: String) = mutate { client.coupon(code) }
    suspend fun saveForLater(id: String) {
        val revision = generation
        mutate {
            client.saveProduct(id,true); checkRevision(revision)
            client.quantity(id,0)
        }
    }
    private fun checkRevision(revision: Int) { if (revision != generation) throw CancellationException("Cart session changed") }
}
