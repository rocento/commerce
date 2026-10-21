package com.rocento.mobile

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

data class AppSettingsState(val locale: String = "en", val analyticsEnabled: Boolean = false)
/** Customer changes never reset app preferences. Call mutations on the UI dispatcher. */
class AppSettingsStore(locale: String = "en", analyticsEnabled: Boolean = false, private val saveLocale: (String) -> Unit = {}) {
    private val mutableState = MutableStateFlow(AppSettingsState(if (locale == "ar") "ar" else "en", analyticsEnabled))
    val state = mutableState.asStateFlow()
    var onChange: (() -> Unit)? = null
    fun selectLocale(value: String) {
        if (value !in listOf("en", "ar") || value == state.value.locale) return
        saveLocale(value); mutableState.value = state.value.copy(locale = value); onChange?.invoke()
    }
    /** Serialize with the operation gate; rejected consent leaves the setting unchanged. */
    suspend fun consent(value: Boolean, save: suspend (Boolean) -> Unit) {
        save(value); mutableState.value = state.value.copy(analyticsEnabled = value); onChange?.invoke()
    }
}
