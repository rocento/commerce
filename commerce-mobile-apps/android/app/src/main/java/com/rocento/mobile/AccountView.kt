package com.rocento.mobile

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp

@Composable fun AccountSignIn(shopping: ShoppingModel, locale: String, initialMode: String = "login") {
    val shoppingState = shoppingUiState(shopping)
    fun t(en: String, ar: String) = if (locale == "ar") ar else en
    var form by remember { mutableStateOf(AuthenticationFormState().open(initialMode)) }
    DisposableEffect(Unit) { onDispose { form = form.clearSecrets() } }
    var notice by remember { mutableStateOf<String?>(null) }
    fun switchMode(value: String) {
        form = form.open(value)
        notice = null; shopping.error = null; shopping.notice = null
    }
    val title = when(form.mode) {
        "register" -> t("Create account", "إنشاء حساب")
        "verify" -> t("Verify account", "تأكيد الحساب")
        "forgot-password" -> t("Forgot password?", "نسيت كلمة المرور؟")
        "reset-password" -> t("Reset password", "إعادة تعيين كلمة المرور")
        else -> t("Sign in", "تسجيل الدخول")
    }
    fun submit() {
        form = form.validate()
        if (form.validation != null) return
        val submitted = form
        val action = form.mode
        if (action == "login") { shopping.login(form.identifier.trim(), form.password); return }
        shopping.auth(action, form.identifier.trim(), form.password.takeIf { action in listOf("register", "reset-password") }, form.code.trim().takeIf { action in listOf("verify", "reset-password") }) {
            if (form != submitted) return@auth
            form = form.complete(submitted)
            notice = when(action) {
                "register" -> t("Account created. Check your email or phone for a verification code.", "تم إنشاء الحساب. تحقق من بريدك أو هاتفك للحصول على رمز التحقق.")
                "forgot-password" -> t("If an account matches, you will receive a reset code. Check your inbox and spam folder.", "إذا كان الحساب موجوداً، فسيصلك رمز إعادة التعيين. تحقق من البريد الوارد وغير المرغوب فيه.")
                "verify" -> t("Account verified. Sign in to continue.", "تم تأكيد الحساب. سجل الدخول للمتابعة.")
                else -> t("Password updated. Sign in with your new password.", "تم تحديث كلمة المرور. سجل الدخول بكلمة المرور الجديدة.")
            }
        }
    }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Icon(Icons.Default.AccountCircle, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(48.dp))
        Text(if (form.mode == "login") t("Welcome back", "مرحباً بعودتك") else title, style = MaterialTheme.typography.headlineMedium, modifier = Modifier.semantics { heading() })
        Text(t("Manage your orders and delivery addresses securely.", "إدارة طلباتك وعناوين التوصيل بأمان."))
        notice?.let { Text(it, modifier = Modifier.testTag("account-success")) }
        OutlinedTextField(form.identifier, { form = form.copy(identifier = it) }, label = { Text(t("Email or phone", "البريد أو الهاتف")) }, singleLine = true, enabled = !shoppingState.busy, keyboardOptions = KeyboardOptions(autoCorrectEnabled = false), modifier = Modifier.fillMaxWidth().testTag("customer-identifier"))
        Text(t("For phone numbers, include the country code, e.g. +201012345678.", "لأرقام الهاتف، أضف رمز الدولة مثل ‎+201012345678."), style = MaterialTheme.typography.bodySmall)
        if (form.mode in listOf("login", "register", "reset-password")) {
            OutlinedTextField(form.password, { form = form.copy(password = it) }, label = { Text(t("Password", "كلمة المرور")) }, singleLine = true, enabled = !shoppingState.busy, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), visualTransformation = if (form.showPassword) VisualTransformation.None else PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth().testTag("customer-password"))
            Row { Switch(form.showPassword, { form = form.copy(showPassword = it) }, enabled = !shoppingState.busy); Text(t("Show password", "إظهار كلمة المرور"), Modifier.padding(12.dp)) }
            if (form.mode != "login") {
                Text(t("Use a long, unique password (12–128 UTF-8 bytes).", "استخدم كلمة مرور طويلة وفريدة (١٢–١٢٨ بايت UTF-8)."), style = MaterialTheme.typography.bodySmall)
                OutlinedTextField(form.confirmation, { form = form.copy(confirmation = it) }, label = { Text(t("Confirm password", "تأكيد كلمة المرور")) }, singleLine = true, enabled = !shoppingState.busy, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth().testTag("customer-confirm-password"))
            }
        }
        if (form.mode in listOf("verify", "reset-password")) {
            OutlinedTextField(form.code, { form = form.copy(code = it) }, label = { Text(t("Verification code", "رمز التحقق")) }, singleLine = true, enabled = !shoppingState.busy, keyboardOptions = KeyboardOptions(autoCorrectEnabled = false), modifier = Modifier.fillMaxWidth().testTag("customer-code"))
            TextButton(onClick = {
                shopping.auth(if (form.mode == "verify") "request-verification" else "forgot-password", form.identifier.trim()) {
                    shopping.notice = null
                    notice = t("If eligible, a code will be sent. Check your inbox and spam folder.", "إذا كان الحساب مؤهلاً، فسيُرسل رمز. تحقق من البريد الوارد وغير المرغوب فيه.")
                }
            }, enabled = !shoppingState.busy && form.identifier.isNotBlank()) { Text(t("Send a new code", "إرسال رمز جديد")) }
        }
        form.validation?.let { issue ->
            val message = when(issue) {
                "identifier" -> t("Enter your email or phone number.", "أدخل بريدك الإلكتروني أو رقم هاتفك.")
                "password" -> t("Enter your password.", "أدخل كلمة المرور.")
                "length" -> t("Use a password of 12–128 UTF-8 bytes; Arabic letters may use more than one byte.", "استخدم كلمة مرور من ١٢ إلى ١٢٨ بايت UTF-8؛ قد يستخدم الحرف العربي أكثر من بايت.")
                "confirmation" -> t("Passwords do not match.", "كلمتا المرور غير متطابقتين.")
                else -> t("Enter the verification code you received.", "أدخل رمز التحقق الذي تلقيته.")
            }
            Text(message, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("account-validation"))
        }
        Button(shape = LocalStorefrontButtonShape.current, onClick = { submit() }, enabled = !shoppingState.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("customer-submit")) { Text(if (form.mode == "forgot-password") t("Send reset code", "إرسال رمز إعادة التعيين") else title) }
        if (form.mode == "login") {
            HorizontalDivider()
            Text(t("New here?", "جديد هنا؟"), style = MaterialTheme.typography.bodyMedium)
            OutlinedButton(shape = LocalStorefrontButtonShape.current, onClick = { switchMode("register") }, enabled = !shoppingState.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("account-register")) { Text(t("Create account", "إنشاء حساب")) }
            TextButton(onClick = { switchMode("forgot-password") }, enabled = !shoppingState.busy, modifier = Modifier.testTag("account-forgot")) { Text(t("Forgot password?", "نسيت كلمة المرور؟")) }
            TextButton(onClick = { switchMode("verify") }, enabled = !shoppingState.busy) { Text(t("Verify an existing account", "تأكيد حساب موجود")) }
        } else {
            TextButton(onClick = { switchMode("login") }, enabled = !shoppingState.busy, modifier = Modifier.testTag("account-back")) { Text(t("Back to sign in", "العودة لتسجيل الدخول")) }
        }
    }
}
