package com.rocento.mobile

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*

data class WishlistState(val ids: List<String> = emptyList(), val products: Map<String,Product> = emptyMap(), val resolved: Set<String> = emptySet(), val limit: Int = 24, val loaded: Boolean = false, val loading: Boolean = false, val failed: Boolean = false, val locale: String? = null)
class WishlistStore(private val fetchIDs: suspend () -> List<String>, private val fetchProduct: suspend (String,String) -> Product, private val saveProduct: suspend (String,Boolean) -> Unit) {
    constructor(client: CommerceClient): this({client.wishlist()},{id,locale->client.product(id,locale)},{id,saved->client.saveProduct(id,saved)})
    private val mutableState=MutableStateFlow(WishlistState())
    val state=mutableState.asStateFlow()
    var onChange: (() -> Unit)? = null
    private var generation=0
    private fun publish(value: WishlistState) { mutableState.value=value;onChange?.invoke() }
    fun reset() { generation++;publish(WishlistState()) }
    fun invalidate() { generation++;publish(state.value.copy(loaded=false,loading=false)) }
    private suspend fun check(revision: Int) { currentCoroutineContext().ensureActive();if(revision!=generation)throw CancellationException() }
    private suspend fun run(operation: suspend (Int) -> Unit) {
        val revision=++generation;publish(state.value.copy(loading=true,failed=false))
        try { operation(revision) }
        catch(e:Exception) { check(revision);publish(state.value.copy(failed=true));throw e }
        finally { if(generation==revision)publish(state.value.copy(loading=false)) }
    }
    suspend fun refreshIDs() = run { revision ->
        val ids=fetchIDs().distinct();check(revision)
        publish(state.value.copy(ids=ids,products=state.value.products.filterKeys{it in ids},resolved=state.value.resolved.intersect(ids.toSet())))
    }
    suspend fun load(locale: String, more: Boolean = false) {
        if(state.value.locale!=locale)publish(state.value.copy(locale=locale,products=emptyMap(),resolved=emptySet(),loaded=false,limit=24))
        val limit=if(more)state.value.limit+24 else 24
        run { revision ->
            val ids=fetchIDs().distinct();check(revision);val products=mutableMapOf<String,Product>()
            for(id in ids.take(limit)) {
                try { val product=fetchProduct(id,locale);if(product.active!=false)products[id]=product }
                catch(e:CommerceFailure){if(e.status!=404)throw e}
                check(revision)
            }
            publish(state.value.copy(ids=ids,products=products,resolved=ids.take(limit).toSet(),limit=limit,loaded=true))
        }
    }
    suspend fun save(id: String, saved: Boolean, product: Product? = null) = run { revision ->
        saveProduct(id,saved);check(revision)
        val old=state.value
        publish(old.copy(ids=old.ids.filter{it!=id}.let{if(saved)listOf(id)+it else it},products=if(!saved)old.products-id else if(product!=null)old.products+(id to product) else old.products,resolved=if(!saved)old.resolved-id else if(product!=null)old.resolved+id else old.resolved))
    }
}
