package com.rocento.mobile

import androidx.compose.ui.test.*
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

/** Opt-in catalog navigation only. Build with assembleRocentoDebugAndroidTest, install -r,
 * then invoke adb shell am instrument manually. Never use connectedRocentoDebugAndroidTest
 * on a user installation: Gradle's uninstall_after_test cleanup removes app data.
 */
class CategoryLiveTests {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    @Test fun categoryFiltersUseLiveProducts() {
        assumeTrue(BuildConfig.PRODUCTION && InstrumentationRegistry.getArguments().getString("rocentoLiveReadOnly") == "true")
        compose.waitUntil(20000) { compose.onAllNodesWithTag("tab-categories").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("tab-categories").performClick()
        val category = "category-7edd7367-5330-47c4-8fa9-73c18f23ea67"
        compose.waitUntil(20000) { compose.onAllNodesWithTag(category).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag(category).performScrollTo().performClick()
        compose.waitUntil(20000) { compose.onAllNodesWithText("15 products").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Filter & sort").performClick()
        compose.onNodeWithTag("category-min").performSemanticsAction(SemanticsActions.SetProgress) { it(3f) }
        compose.onNodeWithText("Show results").performClick()
        compose.onNodeWithText("Apply filters").assertDoesNotExist()
        compose.waitUntil(20000) { compose.onAllNodesWithText("6 products").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Filter & sort").performClick()
        compose.onNodeWithText("Reset").performScrollTo().performClick()
        compose.onNodeWithText("Show results").performClick()
        compose.waitUntil(20000) { compose.onAllNodesWithText("15 products").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Back to categories").performScrollTo().performClick()
        compose.onNodeWithTag(category).assertExists()
    }
}
