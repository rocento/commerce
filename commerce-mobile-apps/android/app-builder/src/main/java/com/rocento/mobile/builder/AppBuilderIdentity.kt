package com.rocento.mobile.builder

import com.rocento.mobile.AppIdentity
import com.rocento.mobile.digest

/** Trusted builder origin belongs to this optional adapter only. */
data class AppBuilderIdentity(val app: AppIdentity, val configBase: String) {
    init { app.copy(commerceBase = configBase) } // Reuse the trusted HTTPS-origin validation.
    val merchantId get() = app.merchantId
    val environment get() = app.environment
    val runtime get() = app.runtime
    val cacheKey get() = digest("$merchantId|$environment|android|$configBase".toByteArray())
}
