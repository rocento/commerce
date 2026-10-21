package com.rocento.mobile

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.Serializable

@Serializable data class HistoryTurn(val conversation_id:String,val request_id:String,val question:String,val answer:String,val created_at:String,val blocks:List<AssistantBlock>?=null)
fun validateHistory(turns:List<HistoryTurn>){require(turns.size<=100 && turns.map{it.request_id}.distinct().size==turns.size);turns.forEach{require(assistantUUID(it.conversation_id)&&assistantUUID(it.request_id)&&it.question.length<=16000&&it.answer.length<=65536&&it.created_at.isNotEmpty()&&(it.blocks?.size ?: 0)<=32);it.blocks.orEmpty().forEach{block->block.validate()}}}
data class SavedConversation(val id:String,val title:String,val updated:String)
val preferenceAttributes=listOf("product","brand","color","style","metal","material")
val memoryOccasions=listOf("any","everyday","gift","work","travel")
@Serializable data class MemoryPreferenceInput(val attribute:String="product",val value:String="",val category_id:String="",val occasion:String="any",val recipient:String="self",val goal_id:String?=null,val dislike:Boolean=false,val replaces:String?=null) {
    fun valid(view:MemoryView?)=view!=null && view.personalized && attribute in preferenceAttributes && occasion in memoryOccasions && recipient in listOf("self","other") && view.categories.any{it.id==category_id} && value.isNotBlank() && value.codePointCount(0,value.length)<=100 && (attribute!="product" || view.products.any{it.id==value && it.category_id==category_id} || view.preferences.any{it.id==replaces && it.value==value && it.category_id==category_id})
}
@Serializable data class MemoryPreference(val id:String,val attribute:String,val value:String,val category_id:String,val occasion:String,val recipient:String,val goal_id:String?=null,val signal:String) {val input get()=MemoryPreferenceInput(attribute,value,category_id,occasion,recipient,goal_id,signal=="explicit_dislike",id)}
@Serializable data class MemoryCategory(val id:String,val name:String)
@Serializable data class MemoryProduct(val id:String,val name:String,val category_id:String)
@Serializable data class MemorySignal(val product_id:String,val name:String,val kind:String)
@Serializable data class MemoryView(val enabled:Boolean,val guest:Boolean,val personalized:Boolean,val journey_consent:Boolean,val consent_version:Int,val expires_at:String?=null,val preferences:List<MemoryPreference>,val signals:List<MemorySignal>,val categories:List<MemoryCategory>,val products:List<MemoryProduct>)
@Serializable data class SavedGoal(val task_id:String,val name:String,val archived:Boolean,val version:Int,val state:String?=null,val expires_at:String)
sealed interface MemoryAction {
    data class Consent(val personalized:Boolean,val journey:Boolean,val version:Int):MemoryAction
    data class Preference(val input:MemoryPreferenceInput):MemoryAction
    data class RemovePreference(val id:String):MemoryAction
    data class ClearContext(val id:String):MemoryAction
    data object Delete:MemoryAction
    data class Goal(val goal:SavedGoal,val name:String,val archived:Boolean):MemoryAction
    data class DeleteGoal(val goal:SavedGoal):MemoryAction
}
data class AssistantLibraryState(val history:List<HistoryTurn> = emptyList(),val memory:MemoryView?=null,val goals:List<SavedGoal> = emptyList(),val draft:MemoryPreferenceInput=MemoryPreferenceInput(),val busy:Boolean=false,val failed:Boolean=false,val loaded:Boolean=false,val needsRefresh:Boolean=false,val exported:String?=null,val changed:Boolean=false)
class AssistantLibrary(private val client:CommerceClient) {
    private val mutableState=MutableStateFlow(AssistantLibraryState());val state=mutableState.asStateFlow()
    var onChange:(()->Unit)?=null
    private var generation=0
    private fun publish(value:AssistantLibraryState){mutableState.value=value;onChange?.invoke()}
    private suspend fun check(revision:Int){currentCoroutineContext().ensureActive();if(revision!=generation)throw CancellationException("Session changed")}
    fun reset(){generation++;publish(AssistantLibraryState())}
    fun edit(value:MemoryPreferenceInput){if(!state.value.busy && !state.value.needsRefresh)publish(state.value.copy(draft=value))}
    fun clearExport(){publish(state.value.copy(exported=null))}
    fun conversations(search:String)=state.value.history.groupBy{it.conversation_id}.mapNotNull{(id,values)->val sorted=values.sortedBy{it.created_at};if(search.isNotEmpty() && values.none{(it.question+" "+it.answer).contains(search,ignoreCase=true)})null else SavedConversation(id,sorted.first().question,sorted.last().created_at)}.sortedByDescending{it.updated}
    private suspend fun work(operation:suspend (Int)->Unit){if(state.value.busy)return;val revision=generation;publish(state.value.copy(busy=true,failed=false));try{operation(revision)}catch(e:Exception){if(revision==generation)publish(state.value.copy(failed=true));throw e}finally{if(revision==generation)publish(state.value.copy(busy=false))}}
    suspend fun refresh(conversation:String,signedIn:Boolean)=work{revision->
        var failure:Exception?=null
        try{val view=client.memoryView(conversation);check(revision);publish(state.value.copy(memory=view,exported=null))}catch(e:Exception){check(revision);failure=e;publish(state.value.copy(memory=null,exported=null))}
        try{val history=if(signedIn)client.assistantHistory()else emptyList();check(revision);publish(state.value.copy(history=history,loaded=true))}catch(e:Exception){check(revision);if(failure==null)failure=e}
        try{val goals=if(signedIn)client.savedGoals()else emptyList();check(revision);publish(state.value.copy(goals=goals))}catch(e:Exception){check(revision);if(failure==null)failure=e}
        failure?.let{throw it};publish(state.value.copy(needsRefresh=false))
    }
    suspend fun open(id:String,accept:(List<HistoryTurn>)->Unit)=work{revision->val turns=client.assistantHistory(id).filter{it.conversation_id.equals(id,ignoreCase=true)}.sortedBy{it.created_at};check(revision);if(turns.isEmpty())throw CommerceFailure(404,"This conversation is no longer available");accept(turns)}
    suspend fun mutate(action:MemoryAction,conversation:String,signedIn:Boolean){
        if(state.value.needsRefresh || state.value.memory==null)throw CommerceFailure(409,"Refresh memory before making changes")
        if(action is MemoryAction.Preference && !action.input.valid(state.value.memory))throw CommerceFailure(422,"Complete a valid preference")
        work{revision->publish(state.value.copy(needsRefresh=true,exported=null,changed=false));client.changeMemory(action);check(revision);publish(state.value.copy(changed=true,draft=if(action is MemoryAction.Preference || action==MemoryAction.Delete)MemoryPreferenceInput()else state.value.draft))}
        refresh(conversation,signedIn)
    }
    suspend fun export()=work{revision->val value=client.exportMemory();check(revision);publish(state.value.copy(exported=value.toString()))}
    suspend fun resumeGoal(id:String,accept:(List<HistoryTurn>)->Unit)=work{revision->
        val goals=client.savedGoals();check(revision);publish(state.value.copy(goals=goals))
        if(goals.none{it.task_id==id && !it.archived && runCatching{java.time.Instant.parse(it.expires_at).isAfter(java.time.Instant.now())}.getOrDefault(false)})throw CommerceFailure(409,"This saved goal is no longer active")
        val turns=client.assistantHistory(id).filter{it.conversation_id==id}.sortedBy{it.created_at};check(revision);accept(turns)
    }
}
