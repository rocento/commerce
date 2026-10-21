package com.rocento.mobile

import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class StateObservationTests {
    @get:Rule val compose = createComposeRule()
    private class Owner : LifecycleOwner {
        override val lifecycle = LifecycleRegistry(this)
    }
    @Test fun featureSnapshotsPauseAndResumeWithTheScreen() {
        lateinit var owner: Owner
        lateinit var model: ShoppingModel
        compose.setContent {
            owner = remember { Owner().also { it.lifecycle.currentState = Lifecycle.State.RESUMED } }
            val scope = rememberCoroutineScope()
            model = remember {
                val identity = AppIdentity("00000000-0000-0000-0000-000000000099", "preview", "https://state.example.test/api")
                fun credential() = object : CredentialStorage {
                    override fun read(): String? = null
                    override fun save(value: String?) {}
                }
                ShoppingModel(CommerceClient(identity, credential(), credential()), CommerceAnalytics(identity, credential()), scope)
            }
            CompositionLocalProvider(LocalLifecycleOwner provides owner) {
                val state = shoppingUiState(model)
                Text(state.notice ?: "empty", Modifier.testTag("observed-feedback"))
            }
        }
        compose.runOnIdle { model.notice = "visible" }
        compose.onNodeWithTag("observed-feedback").assertTextEquals("visible")
        compose.runOnIdle { owner.lifecycle.currentState = Lifecycle.State.CREATED }
        compose.waitForIdle()
        compose.runOnIdle { model.notice = "background update" }
        compose.onNodeWithTag("observed-feedback").assertTextEquals("visible")
        compose.runOnIdle { owner.lifecycle.currentState = Lifecycle.State.RESUMED }
        compose.onNodeWithTag("observed-feedback").assertTextEquals("background update")
        compose.runOnIdle { owner.lifecycle.currentState = Lifecycle.State.DESTROYED }
    }
}
