package com.rocento.mobile

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

data class AccountState(val customer: CustomerAccount? = null)
class AccountStore(private val client: AccountServing) {
    private val mutableState = MutableStateFlow(AccountState())
    val state = mutableState.asStateFlow()
    var onChange: (() -> Unit)? = null
    var onIdentityChange: (() -> Unit)? = null
    private var generation = 0
    private fun publish(value: AccountState) { mutableState.value = value; onChange?.invoke() }
    fun reset() { generation++; publish(AccountState()); onIdentityChange?.invoke() }
    fun accept(customer: CustomerAccount) {
        if (state.value.customer?.id != customer.id) { generation++; publish(AccountState(customer)); onIdentityChange?.invoke() }
        else publish(state.value.copy(customer = customer))
    }
    suspend fun restore() {
        val revision = generation
        val result = if (state.value.customer == null) client.restore() else client.me()
        checkRevision(revision); accept(result)
    }
    suspend fun login(identifier: String,password: String) {
        reset(); val revision = generation
        val result = client.login(identifier,password); checkRevision(revision); accept(result)
    }
    suspend fun logout() { reset(); client.logout() }
    suspend fun auth(action: String,identifier: String,password: String?,code: String?) {
        val revision = generation
        client.authAction(action,identifier,password,code); checkRevision(revision)
        if (action == "reset-password") reset() else if (state.value.customer != null) restore()
    }
    private fun checkRevision(revision: Int) { if (revision != generation) throw CancellationException("Account session changed") }
}
