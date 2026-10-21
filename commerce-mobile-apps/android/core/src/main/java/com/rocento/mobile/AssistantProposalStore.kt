package com.rocento.mobile

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*
import java.time.Instant
import java.util.UUID

data class AssistantProposalState(val proposal: JsonObject? = null, val busy: Boolean = false, val pending: Boolean = false, val issue: String? = null)
class AssistantProposalStore(private val fetch: suspend () -> JsonObject) {
    private val mutableState=MutableStateFlow(AssistantProposalState())
    val state=mutableState.asStateFlow()
    private var generation=0
    fun reset() { generation++; mutableState.value=AssistantProposalState() }
    val canApply: Boolean get() {
        val p=state.value.proposal ?: return false
        val draft=p["draft"] as? JsonObject; val verdict=(p["execution"] as? JsonObject).text("verdict")
        return p.flag("can_apply") && !p.flag("applied") && runCatching { Instant.parse(p.text("expires_at")).isAfter(Instant.now()) }.getOrDefault(false) && (verdict==null || verdict=="pass") && (draft.text("mode")!="buy_again" || runCatching { UUID.fromString(draft.text("location_id")) }.isSuccess)
    }
    suspend fun reload(settled: suspend () -> Unit) {
        if(state.value.busy)return
        val revision=generation; mutableState.value=state.value.copy(busy=true,issue=null)
        try {
            val proposal=fetch(); currentCoroutineContext().ensureActive(); if(revision!=generation)return
            val applied=proposal.flag("applied")
            mutableState.value=state.value.copy(proposal=proposal,pending=if(applied)false else state.value.pending,issue=if(!applied && state.value.pending)"unconfirmed" else null)
            if(applied)settled()
        } catch(e:CancellationException) { throw e }
        catch(e:Exception) { if(revision==generation)mutableState.value=state.value.copy(issue="load") }
        finally { if(revision==generation)mutableState.value=state.value.copy(busy=false) }
    }
    suspend fun apply(locked: Boolean, operation: suspend (String?) -> Unit, settled: suspend () -> Unit) {
        if(state.value.busy || locked)return
        if(state.value.pending){reload(settled);return}
        if(!canApply)return
        val revision=generation; mutableState.value=state.value.copy(busy=true,pending=true,issue=null)
        try { operation((state.value.proposal?.get("draft") as? JsonObject).text("location_id")) }
        catch(e:CancellationException) { throw e }
        catch(e:Exception) { if(revision==generation)mutableState.value=state.value.copy(issue="apply") }
        finally { if(revision==generation)mutableState.value=state.value.copy(busy=false) }
        if(revision==generation)reload(settled)
    }
}
