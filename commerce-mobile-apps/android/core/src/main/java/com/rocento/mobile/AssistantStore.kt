package com.rocento.mobile

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import java.util.UUID

data class AssistantState(val turns:List<AssistantTurn> =emptyList(),val draft:String="",val busy:Boolean=false,val stage:String="preparing",val signInRequired:Boolean=false)
data class AssistantTurn(val id:String,val question:String,val reply:AssistantReply=AssistantReply(),val interrupted:Boolean=false)
interface AssistantServing {
    suspend fun setLocale(value: String)
    suspend fun streamAssistant(input: AssistantInput, onEvent: suspend (AssistantEvent) -> Unit)
}
class AssistantStore(private val client: AssistantServing, private val scope: CoroutineScope) {
    constructor(client: CommerceClient, scope: CoroutineScope): this(object: AssistantServing {
        override suspend fun setLocale(value: String) = client.setLocale(value)
        override suspend fun streamAssistant(input: AssistantInput, onEvent: suspend (AssistantEvent) -> Unit) = client.streamAssistant(input, onEvent)
    }, scope)

    private val mutableState = MutableStateFlow(AssistantState())
    val state = mutableState.asStateFlow()
    var onChange: (() -> Unit)? = null
    var turns: List<AssistantTurn>
        get() = state.value.turns
        private set(value) { mutableState.value = state.value.copy(turns=value); onChange?.invoke() }
    var draft: String
        get() = state.value.draft
        set(value) { mutableState.value = state.value.copy(draft=value); onChange?.invoke() }
    var busy: Boolean
        get() = state.value.busy
        private set(value) { mutableState.value = state.value.copy(busy=value); onChange?.invoke() }
    var stage: String
        get() = state.value.stage
        private set(value) { mutableState.value = state.value.copy(stage=value); onChange?.invoke() }
    var signInRequired: Boolean
        get() = state.value.signInRequired
        private set(value) { mutableState.value = state.value.copy(signInRequired=value); onChange?.invoke() }
    var conversationID=UUID.randomUUID().toString()
        private set
    private var personalization=true
    var personalize:Boolean
        get()=personalization
        set(value){if(!busy){personalization=value;onChange?.invoke()}}
    fun restoreConversation(id:String,history:List<HistoryTurn>){
        if(busy)throw CommerceFailure(409,"Wait for the current response")
        validateHistory(history);generation++;conversationID=id
        mutableState.value=AssistantState(turns=history.map{AssistantTurn(it.request_id,it.question,AssistantReply(text=it.answer,blocks=it.blocks.orEmpty(),completed=true))});onChange?.invoke()
    }
    private var generation=0
    private var job:Job?=null
    fun reset() {
        job?.cancel(); generation++; conversationID = UUID.randomUUID().toString()
        mutableState.value = AssistantState()
        personalization=true
        onChange?.invoke()
    }
    fun stop(){job?.cancel()}
    fun send(message:String,locale:String,productID:String?=null,cartContext:Boolean=false,settled:suspend ()->Unit,checkout:()->Unit) {
        val text=message.trim()
        if(busy || text.isEmpty() || text.codePointCount(0,text.length)>4000)return
        val input=AssistantInput(text,conversationID,product_id=productID ?: if(cartContext)null else turns.lastOrNull()?.reply?.productForFollowup(text),cart_context=if(cartContext)true else null,clarification=turns.lastOrNull()?.reply?.clarification,personalize=personalize)
        val revision=generation
        turns=(turns+AssistantTurn(input.request_id,text)).takeLast(50);draft="";busy=true;stage="preparing";signInRequired=false
        job=scope.launch {
            try {
                client.setLocale(locale)
                client.streamAssistant(input) { event ->
                    withContext(Dispatchers.Main.immediate) {
                        ensureActive()
                        if(generation==revision) {
                            turns=turns.map{if(it.id==input.request_id)it.copy(reply=it.reply.consume(event))else it}
                            if(event.type=="progress")stage=event.stage ?: "preparing"
                            if(event.type=="message.delta")stage="responding"
                        }
                    }
                }
                ensureActive()
            } catch(e:Exception) {
                if(generation==revision) {
                    turns=turns.map{if(it.id==input.request_id)it.copy(interrupted=true,reply=it.reply.copy(failed=true))else it}
                    signInRequired=e is CommerceFailure && e.status==401
                }
            } finally {
                if(generation==revision) {
                    val open=turns.lastOrNull()?.reply?.opensCheckout==true && isActive
                    // An interrupted request may already have updated the cart. Reads are never an action replay.
                    try { withContext(NonCancellable) { settled() } }
                    finally { if(generation==revision)busy=false }
                    if(generation==revision && open && isActive)checkout()
                }
            }
        }
    }
}

