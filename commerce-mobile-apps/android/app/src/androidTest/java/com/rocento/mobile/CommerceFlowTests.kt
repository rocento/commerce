package com.rocento.mobile

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

private class FixtureCredential:CredentialStorage {var value:String?=null;override fun read()=value;override fun save(value:String?){this.value=value}}
private class FlowTransport:HTTPTransport {
    private val fixture=Json.parseToJsonElement(InstrumentationRegistry.getInstrumentation().context.assets.open("commerce-flow.json").bufferedReader().readText()).jsonObject
    var placed=0
    private var ordered=false
    override suspend fun get(url:String,headers:Map<String,String>,maxBytes:Int)=request(url,"GET",headers,null,maxBytes)
    override suspend fun request(url:String,method:String,headers:Map<String,String>,body:String?,maxBytes:Int):HTTPResult {
        val path=java.net.URI(url).path.substringAfter("/v1/")
        var cookies=emptyMap<String,String>()
        val payload=when(path) {
            "customer/auth/login","customer/auth/refresh" -> {cookies=mapOf("Set-Cookie" to "customer_refresh=${"f".repeat(64)}; Secure; HttpOnly");fixture["auth"]!!}
            "customer/auth/register" -> fixture["customer"]!!
            "customer/auth/verify", "customer/auth/forgot-password", "customer/auth/reset-password", "customer/auth/request-verification", "customer/auth/logout" -> JsonObject(emptyMap())
            "customer/me" -> fixture["customer"]!!
            "cart" -> fixture[if(ordered)"empty_cart" else "cart"]!!
            "customer/locations" -> fixture["locations"]!!
            "fulfillment/availability" -> fixture["availability"]!!
            "fulfillment/plan-options" -> fixture["options"]!!
            "fulfillment/plans" -> fixture["plan"]!!
            "customer/checkout/quote" -> fixture["quote"]!!
            "customer/checkout/place" -> {placed++;ordered=true;fixture["detail"]!!}
            "customer/orders" -> JsonArray(if(ordered) listOf(fixture["order"]!!) else emptyList())
            else -> error("Unexpected isolated route: $path")
        }
        return HTTPResult(200,cookies,payload.toString().toByteArray())
    }
}
@RunWith(AndroidJUnit4::class)
class CommerceFlowTests {
    @get:Rule val compose=createComposeRule()
    private fun mount(transport:HTTPTransport,locale:String="en",tab:String="cart") {
        val identity=AppIdentity("312f9ac8-4888-4d35-92a0-e5fdb3bf59b8","production","https://grocery.example.test/api")
        compose.setContent {
            val scope=rememberCoroutineScope()
            val model=remember{ShoppingModel(CommerceClient(identity,FixtureCredential(),FixtureCredential(),transport),CommerceAnalytics(identity,FixtureCredential(),transport),scope)}
            CompositionLocalProvider(LocalLayoutDirection provides if(locale=="ar")LayoutDirection.Rtl else LayoutDirection.Ltr) {
                MaterialTheme { Surface(Modifier.fillMaxSize()) {
                    if (tab == "cart") CommerceView(model,locale,tab,wishlistEnabled=true)
                    else Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp)) { CommerceView(model,locale,tab,wishlistEnabled=true) }
                } }
            }
        }
    }
    @Test fun accountHomeNavigation() = accountHome("en")
    @Test fun arabicAccountHomeNavigation() = accountHome("ar")
    private fun accountHome(locale: String) {
        mount(FlowTransport(),locale,"account")
        val signIn=compose.onNodeWithTag("account-sign-in")
        val register=compose.onNodeWithTag("account-register")
        signIn.performScrollTo().assertHasClickAction()
        val first=signIn.fetchSemanticsNode().boundsInRoot
        val second=register.fetchSemanticsNode().boundsInRoot
        assertEquals(first.width,second.width,1f)
        assertEquals(first.left,second.left,1f)
        compose.onNodeWithTag("account-sign-out").assertDoesNotExist()
        signIn.performClick()
        compose.onNodeWithTag("customer-identifier").performScrollTo().performTextInput("native-fixture@example.test")
        compose.onNodeWithTag("customer-password").performScrollTo().performTextInput("test-only-password")
        compose.onNodeWithTag("customer-submit").performScrollTo().performClick()
        compose.waitUntil(10000){compose.onAllNodesWithTag("account-addresses").fetchSemanticsNodes().isNotEmpty()}
        compose.onNodeWithTag("account-addresses").performScrollTo().performClick()
        compose.onNodeWithText(if(locale=="ar")"إضافة عنوان توصيل" else "Add delivery address").performScrollTo().assertHasClickAction()
        compose.onNodeWithTag("account-home").performScrollTo().performClick()
        compose.onNodeWithTag("account-orders").performScrollTo().performClick()
        compose.onNodeWithText(if(locale=="ar")"لا توجد طلبات بعد" else "No orders yet").assertExists()
        compose.onNodeWithTag("account-home").performScrollTo().performClick()
        compose.onNodeWithTag("account-language-row").performScrollTo().performClick()
        compose.onNodeWithTag("account-language").assertExists()
        compose.onNodeWithTag("account-home").performScrollTo().performClick()
        compose.onNodeWithTag("account-sign-out").performScrollTo().performClick()
        compose.waitUntil(10000){compose.onAllNodesWithTag("account-sign-in").fetchSemanticsNodes().isNotEmpty()}
    }
    @Test fun customerReviewsBeforeExplicitOrderConfirmation() {
        val transport=FlowTransport();mount(transport)
        compose.onNodeWithTag("customer-identifier").performScrollTo().performTextInput("native-fixture@example.test")
        compose.onNodeWithTag("customer-password").performScrollTo().performTextInput("test-only-password")
        compose.onNodeWithTag("customer-submit").performScrollTo().performClick()
        compose.waitUntil(10000){compose.onAllNodesWithTag("cart-checkout").fetchSemanticsNodes().isNotEmpty()}
        compose.onNodeWithTag("cart-checkout").performClick()
        compose.onNodeWithTag("delivery-options").performScrollTo().performClick()
        compose.onNodeWithTag("review-order").performScrollTo().performClick()
        compose.onNodeWithTag("checkout-total").performScrollTo().assertTextContains("30.00", substring = true)
        assertEquals(0,transport.placed)
        compose.onNodeWithTag("place-order").performScrollTo().performClick()
        compose.waitUntil(10000){compose.onAllNodesWithTag("order-confirmation").fetchSemanticsNodes().isNotEmpty()}
        compose.onNodeWithTag("order-confirmation").performScrollTo().assertTextEquals("Order #42")
        assertEquals(1,transport.placed)
    }
    @Test fun registrationAndRecoverySteps() = registrationAndRecovery("en")
    @Test fun arabicRegistrationAndRecoverySteps() = registrationAndRecovery("ar")
    private fun registrationAndRecovery(locale: String) {
        mount(FlowTransport(),locale)
        compose.onNodeWithTag("account-register").performScrollTo().performClick()
        compose.onNodeWithTag("customer-identifier").performScrollTo().performTextInput("native-fixture@example.test")
        compose.onNodeWithTag("customer-password").performScrollTo().performTextInput("test-only-password")
        compose.onNodeWithTag("customer-submit").performScrollTo().performClick()
        compose.onNodeWithTag("account-validation").assertExists()
        compose.onNodeWithTag("customer-confirm-password").performScrollTo().performTextInput("test-only-password")
        compose.onNodeWithTag("customer-submit").performScrollTo().performClick()
        compose.onNodeWithTag("customer-code").performScrollTo().performTextInput("fixture-verification-token")
        compose.onNodeWithTag("customer-submit").performScrollTo().performClick()
        compose.onNodeWithTag("account-forgot").performScrollTo().performClick()
        compose.onNodeWithTag("customer-password").assertDoesNotExist()
        compose.onNodeWithTag("customer-submit").performScrollTo().performClick()
        compose.onNodeWithTag("customer-password").performScrollTo().performTextInput("new-test-password")
        compose.onNodeWithTag("customer-confirm-password").performScrollTo().performTextInput("new-test-password")
        compose.onNodeWithTag("customer-code").performScrollTo().performTextInput("fixture-reset-token")
        compose.onNodeWithTag("customer-submit").performScrollTo().performClick()
        compose.onNodeWithTag("account-register").assertExists()
        compose.onNodeWithTag("customer-password").assert(SemanticsMatcher.expectValue(SemanticsProperties.EditableText, AnnotatedString("")))
    }
    @Test fun arabicAccountControlsRemainAccessible() {
        mount(FlowTransport(),"ar")
        compose.onNodeWithTag("customer-identifier").performScrollTo().assertExists().performTextInput("native-fixture@example.test")
        compose.onNodeWithTag("customer-password").performScrollTo().assertExists()
        compose.onNodeWithTag("customer-submit").performScrollTo().assertHasClickAction()
    }
}
