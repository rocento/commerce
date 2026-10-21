package com.rocento.mobile

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

data class OrderState(
    val orders: List<CustomerOrder> = emptyList(), val detail: CustomerOrderDetail? = null,
    val loading: Boolean = false, val detailLoading: Boolean = false,
    val failed: Boolean = false, val detailFailed: Boolean = false,
    val loaded: Boolean = false, val hasMore: Boolean = true, val selectedID: String? = null,
)
/** Customer-scoped; invoke mutations on the UI dispatcher. */
class OrderStore(private val list: suspend (Int) -> List<CustomerOrder>, private val fetch: suspend (String) -> CustomerOrderDetail) {
    constructor(client: OrderServing): this({ client.orders(it) }, { client.order(it) })
    private val mutableState = MutableStateFlow(OrderState())
    val state = mutableState.asStateFlow()
    var onChange: (() -> Unit)? = null
    private var listRevision = 0
    private var detailRevision = 0
    private var offset = 0
    private fun publish(value: OrderState) { mutableState.value = value; onChange?.invoke() }
    fun reset() { listRevision++; detailRevision++; offset=0; publish(OrderState()) }
    fun show(value: CustomerOrderDetail?) {
        detailRevision++; publish(state.value.copy(detail=value,selectedID=value?.order?.id,detailLoading=false,detailFailed=false))
    }
    fun setOrders(value: List<CustomerOrder>) {
        listRevision++; offset=value.size
        publish(state.value.copy(orders=value.distinctBy { it.id },loaded=true,loading=false,failed=false,hasMore=value.isNotEmpty()))
    }
    suspend fun refresh(more: Boolean = false): Int {
        if(more && (state.value.loading || !state.value.hasMore)) return 0
        val revision = ++listRevision
        publish(state.value.copy(loading=true,failed=false))
        try {
            val page = list(if(more) offset else 0)
            if(revision!=listRevision) throw CancellationException("Order history changed")
            offset=(if(more) offset else 0)+page.size
            publish(state.value.copy(orders=((if(more) state.value.orders else emptyList())+page).distinctBy { it.id },loading=false,loaded=true,hasMore=page.isNotEmpty()))
            return page.size
        } catch(error: Exception) {
            if(revision!=listRevision) throw CancellationException("Order history changed")
            publish(state.value.copy(loading=false,failed=error !is CancellationException)); throw error
        }
    }
    suspend fun track(id: String) {
        val revision=++detailRevision
        publish(state.value.copy(selectedID=id,detail=if(state.value.selectedID==id) state.value.detail else null,detailLoading=true,detailFailed=false))
        try {
            val result=fetch(id)
            if(revision!=detailRevision) throw CancellationException("Order selection changed")
            publish(state.value.copy(detail=result,detailLoading=false))
        } catch(error: Exception) {
            if(revision!=detailRevision) throw CancellationException("Order selection changed")
            publish(state.value.copy(detailLoading=false,detailFailed=error !is CancellationException)); throw error
        }
    }
}
