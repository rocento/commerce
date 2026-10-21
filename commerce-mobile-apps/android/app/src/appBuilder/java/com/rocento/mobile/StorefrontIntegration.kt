package com.rocento.mobile

import androidx.lifecycle.compose.collectAsStateWithLifecycle

import android.app.Application
import android.content.Intent
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.rocento.mobile.builder.*
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** Compiled only with -PappBuilder=true. */
class StorefrontIntegration(application: Application, identity: AppIdentity, fallback: ByteArray,
                            validator: ConfigValidator, production: Boolean,
                            credentials: (String) -> CredentialStorage, transport: HTTPTransport) {
    val preview = if (draftPreview) runCatching {
        val capability = File(application.filesDir, "studio-preview-code")
        val code = try { capability.readText().trim() } finally { capability.delete() }
        DraftPreviewConfiguration(AppBuilderIdentity(identity, BuildConfig.PREVIEW_ORIGIN), code, fallback, validator, transport)
    }.getOrNull() else null
    val builder = if (production && !draftPreview) AppBuilderConfiguration(
        AppBuilderIdentity(identity, "https://grocery.rocento.com/api"), BuildConfig.APPLICATION_ID,
        credentials("config-device"), File(application.cacheDir, "mobile-config"), fallback, validator, transport,
    ) else null
    val configuration: StorefrontConfiguration = preview ?: builder ?: BundledConfiguration(identity, fallback, validator)
    var connecting by mutableStateOf(false)
    var message by mutableStateOf("")
    companion object {
        private var draftPreview = false
        fun configure(intent: Intent) {
            draftPreview = BuildConfig.DEBUG && intent.getBooleanExtra("rocento-draft-preview", false)
        }
    }
    suspend fun connect(code: String, model: StorefrontModel) {
        val adapter = builder ?: return
        if (connecting) return
        connecting = true
        message = ""
        try {
            adapter.enrollment.enroll(code)
            message = model.copy("App connected. Refresh to load published updates.", "تم ربط التطبيق. حدّث لتحميل التصميم المنشور.")
            model.load()
        } catch (e: CancellationException) { throw e }
          catch (_: Exception) { message = model.copy("Unable to connect. Check the code or request a new one.", "تعذر الربط. تحقق من الرمز أو اطلب رمزاً جديداً.") }
        finally { connecting = false }
    }
}

@Composable fun StorefrontSettings(model: StorefrontModel) {
    val settingsState by model.settings.state.collectAsStateWithLifecycle()
    fun localized(en: String, ar: String) = if (settingsState.locale == "ar") ar else en
    val integration = model.integration
    if (integration.builder == null) return
    val scope = rememberCoroutineScope()
    var expanded by remember { mutableStateOf(false) }
    var code by remember { mutableStateOf("") }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        TextButton(onClick = { expanded = !expanded }) { Text(localized("App connection", "ربط التطبيق")) }
        if (expanded) {
            Text(localized("Published design version", "إصدار التصميم المنشور") + " ${model.config.configVersion}")
            OutlinedTextField(code, { code = it }, label = { Text(localized("One-time connection code", "رمز الربط لمرة واحدة")) }, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth().testTag("enrollment-code"))
            Button(shape = LocalStorefrontButtonShape.current, onClick = { val value = code; code = ""; scope.launch { integration.connect(value, model) } }, enabled = !integration.connecting && code.trim().length == 64, modifier = Modifier.testTag("enrollment-connect")) { Text(localized("Connect app", "ربط التطبيق")) }
            if (integration.message.isNotEmpty()) Text(integration.message)
        }
    }
}

@Composable fun StorefrontIntegrationEffects(model: StorefrontModel) {
    val settingsState by model.settings.state.collectAsStateWithLifecycle()
    val preview = model.integration.preview ?: return
    LaunchedEffect(preview, settingsState.locale) {
        while (true) {
            try {
                // Draft display stays responsive while commerce is loading.
                preview.render(settingsState.locale, model::applyConfiguration)
            } catch (e: CancellationException) { throw e }
              catch (_: Exception) { /* Status expires in Builder; preserve last native design. */ }
            kotlinx.coroutines.delay(2000)
        }
    }
}
