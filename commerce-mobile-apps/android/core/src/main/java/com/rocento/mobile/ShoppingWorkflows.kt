package com.rocento.mobile

import kotlinx.coroutines.CancellationException

/** Runs inside the existing operation gate; never acquires a nested gate. */
class ShoppingWorkflows(
    private val restoreAccount: suspend () -> Boolean,
    private val recoverySteps: List<suspend () -> Unit>,
    private val revision: () -> Int,
    private val saveItem: suspend (String) -> Unit,
    private val refreshWishlist: suspend () -> Unit,
) {
    suspend fun recover() { if (restoreAccount()) reload() }
    suspend fun reload() {
        val expected = revision()
        for (step in recoverySteps) {
            checkRevision(expected)
            step()
            checkRevision(expected)
        }
    }
    suspend fun saveForLater(id: String) {
        val expected = revision()
        saveItem(id)
        checkRevision(expected)
        refreshWishlist()
    }
    private fun checkRevision(expected: Int) {
        if (expected != revision()) throw CancellationException("Session changed")
    }
}
