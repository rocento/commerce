package com.rocento.mobile

import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

/** Explicitly opt in to enrollment; catalog read-only tests never enroll an installation. */
class BuilderEnrollmentLiveTests {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    @Test fun enrollForPublishedDesign() {
        assumeTrue(BuildConfig.PRODUCTION && InstrumentationRegistry.getArguments().getString("rocentoLiveEnrollment") == "true")
        val model = androidx.lifecycle.ViewModelProvider(compose.activity)[StorefrontModel::class.java]
        val enrollment = requireNotNull(model.integration.builder).enrollment
        val codeFile = java.io.File(InstrumentationRegistry.getInstrumentation().targetContext.filesDir, "category-reconnect")
        require(codeFile.exists()) { "Supply a one-time enrollment code file" }
        val code = codeFile.readText().trim()
        try { kotlinx.coroutines.runBlocking { enrollment.enroll(code) } } finally { codeFile.delete() }
        compose.runOnIdle { model.load() }
        compose.waitUntil(60000) { !model.loading && model.config.configVersion > 0 }
        assertTrue(enrollment.connected())
    }
}
