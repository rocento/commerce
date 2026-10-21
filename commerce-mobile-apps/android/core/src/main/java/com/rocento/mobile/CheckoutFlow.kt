package com.rocento.mobile

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

data class CheckoutSelection(val method: String, val location: String?, val source: String?, val date: String, val asap: Boolean)

enum class CheckoutPhase { EDITING, LOADING_OPTIONS, QUOTING, READY, SUBMITTING, UNCERTAIN, COMPLETED }
data class CheckoutState(
    val phase: CheckoutPhase = CheckoutPhase.EDITING,
    val quote: CommerceQuote? = null,
    val options: FulfillmentOptions? = null,
    val windows: Map<String, FulfillmentSlot> = emptyMap(),
    val giftMessage: String = "",
) {
    val giftMessageValid get() = giftMessage.toByteArray(Charsets.UTF_8).size <= 500
    val busy get() = phase in setOf(CheckoutPhase.LOADING_OPTIONS, CheckoutPhase.QUOTING, CheckoutPhase.SUBMITTING)
    val locked get() = phase == CheckoutPhase.SUBMITTING || phase == CheckoutPhase.UNCERTAIN
}

/** UI-scoped, single-dispatcher checkout flow. CommerceClient owns durable retry keys. */
class CheckoutFlow {
    private val mutableState = MutableStateFlow(CheckoutState())
    val state = mutableState.asStateFlow()
    private var generation = 0
    suspend fun findOptions(client: CheckoutServing, selection: CheckoutSelection) = loadOptions {
        client.deliveryOptions(selection.method, selection.location, selection.source, selection.date, selection.asap)
    }
    suspend fun review(client: CheckoutServing, selection: CheckoutSelection) {
        val message = state.value.giftMessage
        val slots = state.value.windows.values.toList()
        val revision = generation
        review {
            client.reserveDelivery(selection.method, selection.location, selection.source, selection.date, selection.asap, slots, java.util.UUID.randomUUID().toString())
            checkRevision(revision)
            client.quote(selection.location, message)
        }
    }
    suspend fun place(client: CheckoutServing) = place({ client.place(it) }, { client.pendingCheckout()?.quote })
    fun reset() { generation++; mutableState.value = CheckoutState() }
    fun invalidate() { if (!state.value.locked) { generation++; mutableState.value = CheckoutState(giftMessage = state.value.giftMessage) } }
    fun setGiftMessage(value: String) {
        if (!state.value.busy && !state.value.locked) mutableState.value = state.value.copy(giftMessage = value, quote = null, phase = CheckoutPhase.EDITING)
    }
    fun restore(quote: CommerceQuote?) {
        reset()
        if (quote != null) mutableState.value = CheckoutState(CheckoutPhase.UNCERTAIN, quote, giftMessage = quote.snapshot.gift_message.orEmpty())
    }
    fun select(slots: Map<String, FulfillmentSlot>) {
        if (!state.value.busy && !state.value.locked)
            mutableState.value = state.value.copy(phase = CheckoutPhase.EDITING, quote = null, windows = slots.toMap())
    }
    fun edit() {
        if (!state.value.busy && !state.value.locked)
            mutableState.value = state.value.copy(phase = CheckoutPhase.EDITING, quote = null)
    }
    suspend fun loadOptions(operation: suspend () -> FulfillmentOptions) {
        checkEditable(); invalidate()
        val revision = generation
        mutableState.value = state.value.copy(phase = CheckoutPhase.LOADING_OPTIONS)
        try {
            val result = operation()
            checkRevision(revision)
            mutableState.value = state.value.copy(phase = CheckoutPhase.EDITING, options = result)
        } catch (e: Exception) {
            if (revision == generation) mutableState.value = state.value.copy(phase = CheckoutPhase.EDITING)
            throw e
        }
    }
    suspend fun review(operation: suspend () -> CommerceQuote) {
        checkEditable()
        if (!state.value.giftMessageValid) throw CommerceFailure(422, "Please shorten your gift message")
        val revision = generation
        mutableState.value = state.value.copy(phase = CheckoutPhase.QUOTING, quote = null)
        try {
            val result = operation()
            checkRevision(revision)
            mutableState.value = state.value.copy(phase = CheckoutPhase.READY, quote = result)
        } catch (e: Exception) {
            if (revision == generation) mutableState.value = state.value.copy(phase = CheckoutPhase.EDITING)
            throw e
        }
    }
    suspend fun place(operation: suspend (CommerceQuote) -> CustomerOrderDetail, pending: suspend () -> CommerceQuote?): CustomerOrderDetail {
        val reviewed = state.value.quote
        if (reviewed == null || state.value.phase !in setOf(CheckoutPhase.READY, CheckoutPhase.UNCERTAIN))
            throw CommerceFailure(409, "Review your checkout before confirming")
        val revision = generation
        mutableState.value = state.value.copy(phase = CheckoutPhase.SUBMITTING)
        try {
            val result = operation(reviewed)
            checkRevision(revision)
            mutableState.value = CheckoutState(CheckoutPhase.COMPLETED)
            return result
        } catch (e: Exception) {
            if (revision == generation) {
                mutableState.value = state.value.copy(phase = CheckoutPhase.UNCERTAIN)
                try {
                    val saved = pending()
                    if (revision == generation) mutableState.value = if (saved == null) CheckoutState()
                        else state.value.copy(phase = CheckoutPhase.UNCERTAIN, quote = saved)
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { /* Keep the quote locked if storage cannot confirm the outcome. */ }
            }
            throw e
        }
    }
    private fun checkEditable() {
        if (state.value.busy || state.value.locked) throw CommerceFailure(409, "Checkout is already in progress")
    }
    private fun checkRevision(revision: Int) {
        if (revision != generation) throw CancellationException("Checkout session changed")
    }
}
