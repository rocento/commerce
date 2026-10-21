package com.rocento.mobile

import android.app.Application
import android.content.Intent
import androidx.compose.runtime.Composable

/** Standalone composition has no builder dependency or connection UI. */
class StorefrontIntegration(application: Application, identity: AppIdentity, fallback: ByteArray,
                            validator: ConfigValidator, production: Boolean,
                            credentials: (String) -> CredentialStorage, transport: HTTPTransport) {
    val configuration: StorefrontConfiguration = BundledConfiguration(identity, fallback, validator)
    companion object { fun configure(intent: Intent) {} }
}

@Composable fun StorefrontSettings(model: StorefrontModel) {}

@Composable fun StorefrontIntegrationEffects(model: StorefrontModel) {}
