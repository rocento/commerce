package com.rocento.mobile

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*

data class ProductPromptState(val products: List<Product> = emptyList(), val selected: Set<String> = emptySet(), val loading: Boolean = false, val failed: Boolean = false)
class ProductPromptStore {
    private val mutableState=MutableStateFlow(ProductPromptState())
    val state=mutableState.asStateFlow()
    private var generation=0
    fun reset() { generation++; mutableState.value=ProductPromptState() }
    fun select(id: String, enabled: Boolean) {
        if(state.value.products.none { it.id==id })return
        mutableState.value=state.value.copy(selected=if(enabled)state.value.selected+id else state.value.selected-id)
    }
    suspend fun load(fetch: suspend () -> List<Product>) {
        val revision=++generation; mutableState.value=ProductPromptState(loading=true)
        try {
            val products=fetch(); currentCoroutineContext().ensureActive()
            if(generation==revision)mutableState.value=state.value.copy(products=products.filter { it.active!=false }.take(8))
        } catch(e:CancellationException) { throw e }
        catch(e:Exception) { if(generation==revision)mutableState.value=state.value.copy(failed=true) }
        finally { if(generation==revision)mutableState.value=state.value.copy(loading=false) }
    }
}
