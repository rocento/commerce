package com.rocento.mobile

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class StorefrontTests {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test
    fun categoryFiltersAndBackNavigation() {
        org.junit.Assume.assumeFalse(BuildConfig.PRODUCTION)
        compose.waitUntil(15000) { compose.onAllNodesWithTag("hero-hero_1").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("tab-categories").performClick()
        val category = "category-40000000-0000-0000-0000-00000000000${BuildConfig.MERCHANT}"
        compose.onNodeWithTag(category).performClick()
        compose.onNodeWithText("Filter & sort").performClick()
        compose.onNodeWithTag("category-query").performTextInput("no-matching-product")
        compose.onNodeWithText("Apply filters").assertDoesNotExist()
        compose.waitUntil(15000) { compose.onAllNodesWithText("No products match. Try resetting the filters.").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("No products match. Try resetting the filters.").performScrollTo().assertExists()
        compose.onNodeWithText("Reset").performScrollTo().performClick()
        compose.onNodeWithText("Back to categories").performScrollTo().performClick()
        compose.onNodeWithTag(category).assertExists()
    }
    @Test
    fun catalogToDetailAndArabicNavigation() {
        org.junit.Assume.assumeFalse("Fixture preview test",BuildConfig.PRODUCTION)
        val product = "product-50000000-0000-0000-0000-0000000000${BuildConfig.MERCHANT}1"
        compose.waitUntil(15000) {
            compose.onAllNodesWithTag(product).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithTag(product).performScrollTo().performClick()
        compose.onNodeWithTag("product-detail-title").assertExists()
        compose.onNodeWithTag("product-screen").assertIsDisplayed()
        compose.onNodeWithTag("tab-home").assertDoesNotExist()
        compose.onNodeWithTag("close-product").assertIsDisplayed().performClick()
        compose.onNodeWithTag(product).assertIsDisplayed()
        compose.onNodeWithTag(product).performClick()
        compose.onNodeWithTag("product-detail-title").assertExists()
        compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        compose.onNodeWithTag(product).assertIsDisplayed()
        // Preview apps have no customer Account screen; set the locale through their model.
        lateinit var model: StorefrontModel
        compose.activityRule.scenario.onActivity {
            model = androidx.lifecycle.ViewModelProvider(it)[StorefrontModel::class.java]
            if (model.locale != "ar") model.toggleLanguage()
        }
        compose.waitUntil(15000) { !model.loading && model.locale == "ar" }
        compose.onNodeWithTag("hero-hero_1").performScrollTo().assertHasClickAction().performClick()
        compose.onNodeWithTag("tab-categories").assertIsSelected()
        compose.onAllNodesWithText("الأقسام").assertCountEquals(2)
        compose.onNodeWithText("تصفية وترتيب").assertExists().performClick()
        compose.onNodeWithTag("category-query").assertExists()
        compose.onNodeWithText("العودة إلى الأقسام").performScrollTo().performClick()
        compose.onNodeWithTag("category-40000000-0000-0000-0000-00000000000${BuildConfig.MERCHANT}").assertExists()
    }
}
