package com.rocento.mobile

import android.graphics.Bitmap
import androidx.lifecycle.ViewModelProvider
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import kotlinx.serialization.json.*
import org.junit.Assume.assumeTrue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Explicitly opted-in checks for an operator-designated production test customer. */
@RunWith(AndroidJUnit4::class)
class ProductionCustomerSessionTests {
    @get:Rule val compose = createEmptyComposeRule()
    private fun waitFor(tag: String) = compose.waitUntil(30000) {
        compose.onAllNodes(hasTestTag(tag) and isEnabled()).fetchSemanticsNodes().isNotEmpty()
    }
    private fun waitForText(value: String) = compose.waitUntil(30000) {
        compose.onAllNodesWithText(value).fetchSemanticsNodes().isNotEmpty()
    }
    private fun screenshot(name: String) {
        val i = InstrumentationRegistry.getInstrumentation()
        val dir = File(i.targetContext.filesDir, "production-auth-evidence").apply { mkdirs() }
        val bitmap = i.uiAutomation.takeScreenshot()
        try { File(dir, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG,100,it) } }
        finally { bitmap.recycle() }
    }
    @Test fun productionSession() {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue("Requires explicit production-auth opt-in", args.getString("productionAuth") == "true")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        check(context.packageName == "com.rocento.grocery")
        val phase = args.getString("phase") ?: "session_cycle"
        require(phase in setOf("session_cycle", "restore", "expect_signed_out", "reject_old_password"))
        val needsPassword = phase in setOf("session_cycle", "reject_old_password")
        val input = if (needsPassword) Json.parseToJsonElement(
            File(context.filesDir,"production-auth-input.json").readText()
        ).jsonObject else null
        val email = input?.getValue("identifier")?.jsonPrimitive?.content
            ?: requireNotNull(args.getString("identifier")) { "Requires the designated test customer identifier" }
        val password = input?.getValue("password")?.jsonPrimitive?.content
        val identity = AppIdentity(
            "312f9ac8-4888-4d35-92a0-e5fdb3bf59b8", "production",
            "https://grocery.rocento.com/api",
        )
        val credentials = SecureSession(context, identity, "customer-refresh")
        if (phase == "restore") {
            assertNotNull(
                "No saved customer session on this installation. Sign in on this exact emulator before force-stopping and running restore; do not clear app data or uninstall.",
                credentials.read(),
            )
        }
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            lateinit var model: StorefrontModel
            scenario.onActivity { model = ViewModelProvider(it)[StorefrontModel::class.java] }
            fun settle() {
                compose.waitUntil(30000) { !model.loading }
                compose.waitForIdle()
                compose.waitUntil(30000) { !model.shopping.busy }
                compose.waitForIdle()
            }
            settle()
            waitFor("tab-account")
            compose.onNodeWithTag("tab-account").performClick()
            settle()
            if (phase == "reject_old_password") {
                waitFor("customer-identifier")
                compose.onNodeWithTag("customer-identifier").performScrollTo().performTextReplacement(email)
                compose.onNodeWithTag("customer-password").performScrollTo().performTextReplacement(requireNotNull(password))
                compose.onNodeWithTag("customer-submit").performScrollTo().performClick()
                waitForText("Invalid credentials or expired session")
                compose.onNodeWithTag("customer-identifier").assertExists()
                screenshot("android-old-password-rejected")
                return
            }
            if (phase == "expect_signed_out") {
                waitFor("customer-identifier")
                screenshot("android-session-revoked")
                return
            }
            fun login() {
                settle()
                waitFor("customer-identifier")
                compose.onNodeWithTag("customer-identifier").performScrollTo().performTextReplacement(email)
                compose.onNodeWithTag("customer-password").performScrollTo().performTextReplacement(requireNotNull(password))
                compose.onNodeWithTag("customer-submit").performScrollTo().performClick()
                waitForText(email)
                waitForText("Verified account")
                settle()
            }
            if (phase == "session_cycle") {
                compose.waitUntil(30000) {
                    compose.onAllNodes(hasTestTag("customer-identifier") and isEnabled()).fetchSemanticsNodes().isNotEmpty() ||
                        compose.onAllNodesWithText(email).fetchSemanticsNodes().isNotEmpty()
                }
                if (compose.onAllNodesWithText(email).fetchSemanticsNodes().isEmpty()) login()
                waitForText("Verified account")
                settle()
            } else {
                assertEquals("Saved session did not restore the designated customer", email, model.shopping.customer?.identifier)
                assertTrue("Restored customer must remain verified", model.shopping.customer?.verified == true)
                waitForText(email)
                waitForText("Verified account")
                settle()
            }
            assertNotNull("Successful authentication must persist a refresh credential", credentials.read())
            screenshot("android-$phase-en")
            compose.onNodeWithTag("account-language-ar").performScrollTo().performClick()
            settle()
            waitForText("حساب مؤكد")
            compose.onNodeWithText(email).assertExists()
            screenshot("android-$phase-ar")
            compose.waitUntil(30000) { compose.onAllNodes(hasTestTag("account-language-en") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("account-language-en").performScrollTo().performClick()
            settle()
            waitForText("Verified account")
            if (phase == "session_cycle") {
                compose.onNodeWithText("Sign out").performScrollTo()
                compose.waitUntil(30000) { compose.onAllNodes(hasText("Sign out") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithText("Sign out").assertIsEnabled().performClick()
                waitFor("customer-identifier")
                screenshot("android-sign-out")
                login()
            }
        }
    }
}
