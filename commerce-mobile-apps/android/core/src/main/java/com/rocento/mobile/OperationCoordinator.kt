package com.rocento.mobile

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

enum class OperationKind { Initial, Refresh, Mutation }
data class OperationLoadingState(val active: Boolean = false, val queued: Int = 0, val kind: OperationKind? = null) {
    val busy get() = active || queued > 0
    fun label(locale: String) = when(kind) {
        OperationKind.Initial -> if(locale=="ar") "جارٍ التحميل" else "Loading"
        OperationKind.Refresh -> if(locale=="ar") "جارٍ التحديث" else "Refreshing"
        OperationKind.Mutation -> if(locale=="ar") "جارٍ حفظ التغييرات" else "Updating"
        null -> if(locale=="ar") "في الانتظار" else "Waiting"
    }
}

/** UI-dispatcher FIFO coordinator. Operations must not re-enter their own queue. */
class OperationCoordinator {
    private val mutex = Mutex()
    private val count = MutableStateFlow(0)
    private val mutableLoading = MutableStateFlow(OperationLoadingState())
    val loading = mutableLoading.asStateFlow()
    private var activeKind: OperationKind? = null
    private fun changed() { mutableLoading.value=OperationLoadingState(activeKind!=null,(count.value-if(activeKind!=null)1 else 0).coerceAtLeast(0),activeKind); onChange?.invoke() }
    val pending = count.asStateFlow()
    val busy get() = count.value > 0
    var onChange: (() -> Unit)? = null
    private var generation = 0
    fun invalidatePending() { generation++ }
    suspend fun <T> run(kind: OperationKind = OperationKind.Mutation, operation: suspend () -> T): T {
        val revision = generation
        count.value++; changed()
        try {
            return mutex.withLock {
                currentCoroutineContext().ensureActive()
                if (revision != generation) throw CancellationException("Session changed while waiting")
                activeKind=kind; changed()
                try { operation() } finally { activeKind=null; changed() }
            }
        } finally { count.value--; changed() }
    }
}
