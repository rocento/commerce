package com.rocento.mobile

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.Serializable

@Serializable data class ReviewInput(val display_name:String="",val rating:Int=5,val title:String="",val body:String="") {
    val valid get()=rating in 1..5 && listOf(display_name to 80,title to 200,body to 4000).all{it.first.isNotBlank() && it.first.toByteArray(Charsets.UTF_8).size<=it.second}
}
@Serializable data class ProductReview(val id:String,val display_name:String,val rating:Int,val title:String,val body:String,val created_at:String,val status:String?=null,val version:Int?=null,val moderation_reason:String?=null) {
    val input get()=ReviewInput(display_name,rating,title,body)
}
data class ReviewsState(val product:String="",val reviews:List<ProductReview> = emptyList(),val own:ProductReview?=null,val draft:ReviewInput=ReviewInput(),val offset:Int=0,val busy:Boolean=false,val loaded:Boolean=false,val ownLoaded:Boolean=false,val failed:Boolean=false,val dirty:Boolean=false,val uncertain:Boolean=false,val submitted:Boolean=false)
class ReviewsStore(private val client:CommerceClient) {
    private val mutableState=MutableStateFlow(ReviewsState());val state=mutableState.asStateFlow()
    var onChange:(()->Unit)?=null
    private var generation=0
    private fun publish(value:ReviewsState){mutableState.value=value;onChange?.invoke()}
    private suspend fun check(revision:Int){currentCoroutineContext().ensureActive();if(revision!=generation)throw CancellationException("Session changed")}
    fun reset(){generation++;publish(ReviewsState())}
    fun edit(input:ReviewInput){if(!state.value.busy && !state.value.uncertain)publish(state.value.copy(draft=input,dirty=true,submitted=false))}
    suspend fun open(id:String,signedIn:Boolean){reset();publish(state.value.copy(product=id));load(signedIn,0)}
    suspend fun load(signedIn:Boolean,offset:Int=state.value.offset){
        if(state.value.busy)return
        val revision=generation;publish(state.value.copy(busy=true,failed=false))
        try {
            val items=client.reviews(state.value.product,offset);check(revision)
            publish(state.value.copy(reviews=items,offset=offset,loaded=true))
            val own=if(signedIn)client.ownReview(state.value.product)else null;check(revision)
            publish(state.value.copy(own=own,ownLoaded=true,uncertain=false,draft=if(state.value.dirty)state.value.draft else own?.input ?: ReviewInput()))
        }catch(e:Exception){if(revision==generation)publish(state.value.copy(failed=true));throw e}
        finally {if(revision==generation)publish(state.value.copy(busy=false))}
    }
    suspend fun submit(verified:Boolean){
        val old=state.value
        if(old.busy || !old.ownLoaded || old.uncertain || !verified || !old.draft.valid)throw CommerceFailure(422,"Verify your account and complete a valid review")
        val revision=generation;publish(old.copy(busy=true,submitted=false,uncertain=true))
        try {
            val own=client.submitReview(old.product,old.draft);check(revision)
            publish(state.value.copy(own=own,draft=own.input,dirty=false,submitted=true,uncertain=false,reviews=state.value.reviews.filter{it.id!=own.id}))
            try { val items=client.reviews(old.product,old.offset);check(revision);publish(state.value.copy(reviews=items,failed=false)) }
            catch(e:CancellationException){throw e}
            catch(_:Exception){if(revision==generation)publish(state.value.copy(failed=true))}
        }finally {if(revision==generation)publish(state.value.copy(busy=false))}
    }
}
