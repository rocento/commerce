package com.rocento.mobile

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

data class NavigationState(val tab: String = "home", val panel: String? = null, val cartPanel: String? = null, val assistantPresented: Boolean = false, val checkoutPresented: Boolean = false)
/** Transient routes, separate from catalog and order data. Mutate on the UI dispatcher. */
class NavigationStore {
    private val mutableState = MutableStateFlow(NavigationState())
    val state = mutableState.asStateFlow()
    var onChange: (() -> Unit)? = null
    private var orderReturn: String? = null
    private fun publish(value: NavigationState) { mutableState.value=value; onChange?.invoke() }
    fun selectTab(value: String) {
        if(value!=state.value.tab) { orderReturn=null; publish(NavigationState(tab=value)) }
        else publish(state.value.copy(tab=value))
    }
    fun open(value: String?) {
        if(value=="order" && state.value.panel!="order") orderReturn=state.value.panel?.takeIf { it=="orders" }
        if(value=="notification-order") orderReturn="notifications"
        if(value!="order" && value!="notification-order") orderReturn=null
        publish(state.value.copy(panel=value))
    }
    fun openCart(value: String?) { publish(state.value.copy(cartPanel=value,checkoutPresented=value=="checkout")) }
    fun presentAssistant(value: Boolean) { publish(state.value.copy(assistantPresented=value)) }
    fun presentCheckout(value: Boolean) { openCart(if(value) "checkout" else null) }
    fun back(): Boolean {
        when {
            state.value.assistantPresented -> presentAssistant(false)
            state.value.panel!=null -> { val destination=orderReturn; orderReturn=null; open(destination) }
            state.value.cartPanel!=null -> openCart(null)
            state.value.tab!="home" -> selectTab("home")
            else -> return false
        }
        return true
    }
    fun resetCustomerRoutes(preserveAuthentication: Boolean = false) {
        val panel = state.value.panel.takeIf { preserveAuthentication && it == "auth" }
        orderReturn=null; publish(NavigationState(tab=state.value.tab, panel=panel))
    }
}
