package com.rocento.mobile

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

enum class FailureKind { Validation, Authentication, Permission, Conflict, RateLimit, Server, Connection, Unknown }
data class AppFailure(val kind: FailureKind, val message: String, val status: Int? = null) {
    companion object {
        fun map(error: Exception, locale: String = "en"): AppFailure? {
            if(error is CancellationException) return null
            val fallback=if(locale=="ar") "تعذر الاتصال. تحقق من اتصالك وحاول مرة أخرى." else "Unable to connect. Check your connection and retry."
            if(error is CommerceFailure) {
                val kind=when(error.status) {
                    400,422 -> FailureKind.Validation
                    401 -> FailureKind.Authentication
                    403 -> FailureKind.Permission
                    409 -> FailureKind.Conflict
                    429 -> FailureKind.RateLimit
                    in 500..599 -> FailureKind.Server
                    else -> FailureKind.Unknown
                }
                return AppFailure(kind,error.message.ifEmpty { fallback },error.status)
            }
            return AppFailure(if(error is java.io.IOException) FailureKind.Connection else FailureKind.Unknown,fallback)
        }
    }
}
data class FeedbackState(val failure: AppFailure? = null, val notice: String? = null)
/** Does not retain exceptions or retry closures. Mutate on the UI dispatcher. */
class FeedbackStore {
    private val mutableState=MutableStateFlow(FeedbackState())
    val state=mutableState.asStateFlow()
    var onChange: (() -> Unit)? = null
    private fun publish(value: FeedbackState) { mutableState.value=value; onChange?.invoke() }
    fun setError(message: String?) { publish(state.value.copy(failure=message?.takeIf { it.isNotEmpty() }?.let { AppFailure(FailureKind.Unknown,it) })) }
    fun setNotice(message: String?) { publish(state.value.copy(notice=message?.takeIf { it.isNotEmpty() })) }
    fun clear() { publish(FeedbackState()) }
    suspend fun perform(queue: OperationCoordinator, kind: OperationKind = OperationKind.Mutation, locale: String = "en", onUnauthorized: () -> Unit = {}, operation: suspend () -> Unit): Boolean {
        return queue.run(kind) {
            clear()
            try { operation(); true } catch(error: Exception) {
                val mapped=AppFailure.map(error,locale) ?: throw error
                val completedNotice=state.value.notice
                if(mapped.kind==FailureKind.Authentication) onUnauthorized()
                publish(state.value.copy(failure=mapped,notice=completedNotice)); false
            }
        }
    }
}
