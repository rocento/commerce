package com.rocento.mobile

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.Serializable
import java.util.UUID

val supportCategories=listOf("order_issue","product_question","complaint","payment_dispute","other")
fun supportTextValid(value:String,max:Int)=value.isNotBlank() && value.toByteArray(Charsets.UTF_8).size<=max
@Serializable data class SupportInput(val request_id:String=UUID.randomUUID().toString(),val subject:String="",val category:String="other",val body:String="",val order_id:String?=null,val contact_name:String?=null,val contact:String?=null) {
    fun valid(signedIn:Boolean)=supportTextValid(subject,160) && supportTextValid(body,2000) && category in supportCategories && (signedIn || (order_id==null && supportTextValid(contact_name.orEmpty(),100) && supportTextValid(contact.orEmpty(),254)))
}
@Serializable data class SupportTicket(val id:String,val number:Long,val subject:String,val category:String,val status:String,val priority:String,val order_id:String?=null,val created_at:String)
@Serializable data class SupportMessage(val id:String,val sender:String,val body:String,val created_at:String)
@Serializable data class SupportDetail(val ticket:SupportTicket,val messages:List<SupportMessage>)
data class SupportReply(val id:String,val requestID:String,val body:String)
data class SupportState(val draft:SupportInput=SupportInput(),val attempt:SupportInput?=null,val reply:String="",val replyAttempt:SupportReply?=null,val tickets:List<SupportTicket> = emptyList(),val detail:SupportDetail?=null,val selected:String?=null,val busy:Boolean=false,val loaded:Boolean=false,val failed:Boolean=false,val created:Boolean=false,val replied:Boolean=false,val composing:Boolean=false)
class SupportStore(private val client:CommerceClient) {
    private val mutableState=MutableStateFlow(SupportState());val state=mutableState.asStateFlow()
    var onChange:(()->Unit)?=null
    private var generation=0
    private val replies=mutableMapOf<String,String>()
    private fun publish(value:SupportState){mutableState.value=value;onChange?.invoke()}
    private suspend fun check(revision:Int){currentCoroutineContext().ensureActive();if(revision!=generation)throw CancellationException("Session changed")}
    fun reset(){generation++;replies.clear();publish(SupportState())}
    fun edit(value:SupportInput){if(!state.value.busy && state.value.attempt==null)publish(state.value.copy(draft=value))}
    fun editReply(value:String){if(!state.value.busy && state.value.replyAttempt==null){state.value.selected?.let{replies[it]=value};publish(state.value.copy(reply=value,replied=false))}}
    fun compose(order:String?=null){if(!state.value.busy)publish(state.value.copy(composing=true,created=false,draft=if(state.value.attempt!=null)state.value.draft else state.value.draft.copy(order_id=order ?: state.value.draft.order_id)))}
    fun showList(){if(!state.value.busy)publish(state.value.copy(composing=false,selected=null,detail=null))}
    private suspend fun work(operation:suspend (Int)->Unit){
        if(state.value.busy)return
        val revision=generation;publish(state.value.copy(busy=true,failed=false))
        try{operation(revision)}catch(e:Exception){if(revision==generation)publish(state.value.copy(failed=true));throw e}finally{if(revision==generation)publish(state.value.copy(busy=false))}
    }
    suspend fun refresh()=work{revision->val items=client.supportTickets();check(revision);publish(state.value.copy(tickets=items,loaded=true))}
    suspend fun open(id:String)=work{revision->publish(state.value.copy(selected=id,detail=null,composing=false,reply=replies[id].orEmpty(),created=false,replied=false));val detail=client.supportDetail(id);check(revision);publish(state.value.copy(detail=detail))}
    suspend fun create(signedIn:Boolean)=work{revision->
        val old=state.value
        if(old.attempt==null && !old.draft.valid(signedIn))throw CommerceFailure(422,"Complete the support form")
        val input=old.attempt ?: old.draft;publish(state.value.copy(attempt=input))
        try{val detail=client.createSupport(input);check(revision);publish(state.value.copy(detail=detail,selected=detail.ticket.id,created=true,composing=false,attempt=null,draft=SupportInput(),reply="",tickets=listOf(detail.ticket)+state.value.tickets.filter{it.id!=detail.ticket.id}))}
        catch(e:Exception){check(revision);if(e is CommerceFailure && e.status in listOf(400,422))publish(state.value.copy(attempt=null));throw e}
    }
    suspend fun sendReply()=work{revision->
        val old=state.value;val id=old.selected
        if(id==null || old.detail==null || old.replyAttempt!=null && old.replyAttempt.id!=id)throw CommerceFailure(409,"Return to the pending reply before sending another")
        if(old.replyAttempt==null && !supportTextValid(old.reply,2000))throw CommerceFailure(422,"Enter a message within 2000 bytes")
        val input=old.replyAttempt ?: SupportReply(id,UUID.randomUUID().toString(),old.reply);publish(state.value.copy(replyAttempt=input))
        try{val detail=client.replySupport(id,input.requestID,input.body);check(revision);replies.remove(id);publish(state.value.copy(detail=detail,reply="",replyAttempt=null,replied=true))}
        catch(e:Exception){check(revision);if(e is CommerceFailure && e.status in listOf(400,422))publish(state.value.copy(replyAttempt=null));throw e}
    }
}
