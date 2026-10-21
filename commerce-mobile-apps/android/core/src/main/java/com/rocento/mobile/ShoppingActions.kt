package com.rocento.mobile

import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

/** Cross-feature mutations; the caller owns the existing session operation gate. */
class ShoppingActions(
    private val client: CommerceClient, private val account: AccountStore,
    private val cart: CartStore, private val delivery: DeliveryForm,
    private val checkout: CheckoutFlow, private val orders: OrderStore,
    private val wishlist: WishlistStore, private val workflows: ShoppingWorkflows,
    private val revision: () -> Int,
) {
    private suspend fun check(expected: Int) {
        currentCoroutineContext().ensureActive()
        if (expected != revision()) throw CancellationException("Session changed")
    }
    suspend fun place(confirmed: (CustomerOrderDetail) -> Unit) {
        val expected = revision()
        val order = checkout.place(client)
        check(expected)
        orders.show(order)
        confirmed(order)
        check(expected)
        cart.refresh()
        check(expected)
        orders.refresh()
    }
    suspend fun choose(id: String) {
        val expected = revision()
        delivery.choose(id, client)
        check(expected)
        cart.refresh()
        check(expected)
    }
    suspend fun save(pin: DeliveryPin, address: String, building: String, floor: String, apartment: String, instructions: String) {
        val expected = revision(); val guest = account.state.value.customer == null
        delivery.save(client,pin,address,building,floor,apartment,instructions,guest)
        check(expected)
        if (!guest) { cart.refresh(); check(expected) }
    }
    suspend fun applyProposal(id: String, location: String? = null) {
        val expected = revision()
        cart.mutate { client.applyAssistantProposal(id) }
        check(expected)
        if (location != null) choose(location)
        wishlist.invalidate()
    }
    suspend fun assistantSettled() {
        if (account.state.value.customer == null) return
        val expected = revision()
        checkout.invalidate(); wishlist.invalidate()
        cart.refresh()
        check(expected)
    }
    suspend fun addAssistantProduct(id: String, locale: String, openProduct: (String) -> Unit, added: () -> Unit) {
        val expected = revision()
        val product = client.product(id,locale)
        check(expected)
        if (product.productType != "simple") { openProduct(id); return }
        if (!product.inStock) throw CommerceFailure(409,"This product is no longer available")
        cart.add(id)
        check(expected); added()
    }
    suspend fun login(identifier: String, password: String, authenticated: () -> Unit = {}) {
        account.login(identifier,password)
        val expected = revision()
        authenticated()
        check(expected)
        workflows.reload()
    }
    suspend fun auth(action: String, identifier: String, password: String?, code: String?) {
        account.auth(action,identifier,password,code)
        if (action == "verify" && account.state.value.customer != null) workflows.reload()
    }
    suspend fun logout(beforeLogout: suspend () -> Unit = {}) {
        try { beforeLogout() } finally { withContext(NonCancellable) { account.logout() } }
    }
}
