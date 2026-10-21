package com.rocento.mobile

import android.app.Application
import android.graphics.Bitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

private class IsolatedCredential : CredentialStorage {
    private var value: String? = null
    override fun read() = value
    override fun save(value: String?) { this.value = value }
}

/** Every request is handled here; unexpected routes fail instead of reaching production. */
private class StorefrontFlowTransport(val scenario: String = "happy") : HTTPTransport {
    private val fixture = Json.parseToJsonElement(InstrumentationRegistry.getInstrumentation().context.assets.open("commerce-flow.json").bufferedReader().readText()).jsonObject
    private val ids = fixture["ids"]!!.jsonObject
    var added = false
    var quantity = 1
    var coupon = ""
    var saved = emptyList<String>()
    var ordered = false
    var placed = 0
    var loginAttempts = 0
    var orderReads = 0
    val checkoutKeys = mutableListOf<String>()
    val routes = mutableListOf<String>()
    private fun result(value: JsonElement, status: Int = 200, headers: Map<String,String> = emptyMap()) = HTTPResult(status, headers, value.toString().toByteArray())
    private fun failure(status: Int, message: String) = result(buildJsonObject { put("error", message) }, status)
    override suspend fun stream(url:String,headers:Map<String,String>,body:String,maxBytes:Int,onResponse:suspend (HTTPResult)->Unit,onChunk:suspend (ByteArray)->Boolean) {
        require(java.net.URI(url).path=="/api/v1/assistant/chat")
        routes+="assistant/chat"
        val input=Json.parseToJsonElement(body).jsonObject
        val requestID=input["request_id"]!!.jsonPrimitive.content
        onResponse(HTTPResult(200,mapOf("Content-Type" to "text/event-stream")))
        val ar=headers["X-Storefront-Locale"]=="ar"
        val checkout=input["message"]!!.jsonPrimitive.content.lowercase()=="checkout"
        val variant=fixture["variant"]!!.jsonObject
        val productID=variant["id"]!!.jsonPrimitive.content
        val product=buildJsonObject { put("id",productID);put("name",if(ar)"تفاح الاختبار — ١ كجم" else "Fixture apples — 1 kg");put("image_id",JsonNull);put("price","25.00");put("currency","EGP");put("in_stock",true);put("route","/products/$productID");put("attributes",JsonArray(emptyList()));put("reasons",JsonArray(emptyList()));put("unmet",JsonArray(emptyList())) }
        val values = if(checkout) listOf(
            buildJsonObject { put("type","message.delta");put("text","Review your checkout");put("code","open_checkout");put("response_source","R") },
            buildJsonObject { put("type","done") },
        ) else listOf(
            buildJsonObject { put("type","progress");put("stage","catalog") },
            buildJsonObject { put("type","message.delta");put("text",if(ar)"وجدت لك " else "I found ");put("response_source","R") },
            buildJsonObject { put("type","message.delta");put("text",if(ar)"هذا المنتج." else "a fresh pick.");put("response_source","R") },
            buildJsonObject {
                put("type","content.blocks")
                putJsonArray("blocks") {
                    addJsonObject {
                        put("kind","product_card")
                        put("products",JsonArray(listOf(product)))
                        putJsonArray("sources") { addJsonObject { put("kind","catalog");put("product_id",productID);put("route","/products/$productID") } }
                    }
                }
            },
            buildJsonObject { put("type","done") },
        )
        values.forEachIndexed{index,value->
            if(scenario=="assistant-interrupted" && value["type"]!!.jsonPrimitive.content=="done")return
            kotlinx.coroutines.delay(if(scenario=="assistant-slow")2000 else 350)
            val event=JsonObject(value+mapOf("version" to JsonPrimitive("1"),"request_id" to JsonPrimitive(requestID),"sequence" to JsonPrimitive(index)))
            if(onChunk("data: $event\n\n".toByteArray()))return
        }
    }
    override suspend fun get(url: String, headers: Map<String,String>, maxBytes: Int) = request(url,"GET",headers,null,maxBytes)
    override suspend fun request(url: String, method: String, headers: Map<String,String>, body: String?, maxBytes: Int): HTTPResult {
        val path = java.net.URI(url).path.substringAfter("/v1/")
        routes += path
        if (path == "customer/auth/login" && ++loginAttempts == 1 && scenario == "invalid-login") return failure(401,"Invalid credentials")
        if (path == "customer/orders") orderReads++
        if (scenario == "expired-session" && (path == "customer/auth/refresh" || path == "customer/orders" && orderReads > 1)) return failure(401,"Please sign in")
        if (scenario == "outside-area" && path == "delivery-area") return result(buildJsonObject { put("configured",true);put("deliverable",false) })
        var cookies = emptyMap<String,String>()
        if (path == "cart/items/${ids["variant"]!!.jsonPrimitive.content}") {
            quantity = if(method == "DELETE") 0 else Json.parseToJsonElement(body!!).jsonObject["quantity"]!!.jsonPrimitive.int
            added = quantity > 0
        }
        var value: JsonElement = when(path) {
            "customer/auth/login", "customer/auth/refresh" -> {cookies = mapOf("Set-Cookie" to "customer_refresh=${"f".repeat(64)}; Secure; HttpOnly");fixture["auth"]!!}
            "customer/me", "customer/auth/register" -> fixture["customer"]!!
            "customer/auth/verify", "customer/auth/forgot-password", "customer/auth/reset-password", "customer/auth/request-verification", "customer/auth/logout" -> JsonObject(emptyMap())
            "catalog/categories" -> fixture["categories"]!!
            "theme/storefront" -> buildJsonObject { put("configuration",buildJsonObject { put("pages",buildJsonObject { put("home",fixture["demo_home"]!!) }) }) }
            "search" -> buildJsonObject { put("hits",JsonArray(listOf(fixture["product"]!!))) }
            "catalog/products/${ids["product"]!!.jsonPrimitive.content}" -> fixture["product"]!!
            "catalog/products/${ids["variant"]!!.jsonPrimitive.content}" -> fixture["variant"]!!
            "catalog/products/${ids["product"]!!.jsonPrimitive.content}/family" -> fixture["family"]!!
            "customer/wishlist" -> JsonArray(saved.map(::JsonPrimitive))
            "customer/wishlist/${ids["variant"]!!.jsonPrimitive.content}" -> {
                if(scenario=="save-failed")return failure(503,"Unable to save this product")
                saved=if(method=="PUT")listOf(ids["variant"]!!.jsonPrimitive.content) else emptyList()
                JsonObject(emptyMap())
            }
            "cart/coupon" -> { coupon=Json.parseToJsonElement(body!!).jsonObject["code"]!!.jsonPrimitive.content;fixture[if(added&&!ordered)"cart" else "empty_cart"]!! }
            "cart", "cart/items/${ids["variant"]!!.jsonPrimitive.content}" -> fixture[if(added && !ordered) "cart" else "empty_cart"]!!
            "cart/items" -> { added = true; quantity = 1; fixture["cart"]!! }
            "customer/locations" -> fixture[if(method == "POST") "location" else "locations"]!!
            "delivery-area" -> fixture["coverage"]!!
            "fulfillment/availability" -> fixture["availability"]!!
            "fulfillment/plan-options" -> fixture["options"]!!
            "fulfillment/plans" -> fixture["plan"]!!
            "customer/checkout/quote" -> fixture["quote"]!!
            "customer/checkout/place" -> {
                placed++
                checkoutKeys += Json.parseToJsonElement(body!!).jsonObject["idempotency_key"]!!.jsonPrimitive.content
                if (scenario == "changed-price") return failure(400,"Price changed. Review your bag again.")
                if (scenario == "interrupted-checkout" && placed == 1) throw java.io.IOException("Simulated timeout")
                ordered = true; fixture["detail"]!!
            }
            "customer/orders" -> JsonArray(if(ordered) listOf(fixture["order"]!!) else emptyList())
            "customer/orders/${ids["order"]!!.jsonPrimitive.content}" -> JsonObject(fixture["detail"]!!.jsonObject + ("order" to JsonObject(fixture["order"]!!.jsonObject + ("status" to JsonPrimitive("delivered")))))
            else -> error("Unexpected isolated route: $path")
        }
        if(value is JsonObject && value["id"] == ids["cart"] && added && !ordered) {
            val item = value["items"]!!.jsonArray[0].jsonObject + mapOf(
                "quantity" to JsonPrimitive(quantity), "reserved_quantity" to JsonPrimitive(if(scenario == "stock-shortfall") 0 else quantity),
                "line_total" to JsonPrimitive("${quantity * 25}.00"))
            value = JsonObject(value + mapOf("items" to JsonArray(listOf(JsonObject(item))), "subtotal" to JsonPrimitive("${quantity * 25}.00"), "fully_reserved" to JsonPrimitive(scenario != "stock-shortfall"),
                "discount_amount" to JsonPrimitive(if(coupon=="SAVE5")"5.00" else "0.00"),
                "coupon_code" to (if(coupon.isEmpty())JsonNull else JsonPrimitive(coupon)),
                "coupon_error" to (if(coupon.isEmpty()||coupon=="SAVE5")JsonNull else JsonPrimitive("This code is not valid"))))
        }
        fun localized(input: JsonElement): JsonElement = when(input) {
            is JsonArray -> JsonArray(input.map(::localized))
            is JsonObject -> {
                val fields = input.mapValues { localized(it.value) }.toMutableMap()
                if(scenario == "sold-out" && fields["id"] == ids["variant"]) fields["in_stock"] = JsonPrimitive(false)
                if(headers["X-Storefront-Locale"] == "ar") {
                    val name = (fields["name"] as? JsonPrimitive)?.content
                    val translated = mapOf("Fixture apples" to "تفاح الاختبار", "Fixture apples — 1 kg" to "تفاح الاختبار — ١ كجم", "Fixture fruit" to "فاكهة الاختبار")[name]
                    if(translated != null) fields["name"] = JsonPrimitive(translated)
                }
                JsonObject(fields)
            }
            else -> input
        }
        return result(localized(value), headers = cookies)
    }
}

@RunWith(AndroidJUnit4::class)
class CompleteStorefrontFlowTests {
    @get:Rule val compose = createComposeRule()
    private lateinit var model: StorefrontModel
    private lateinit var transport: StorefrontFlowTransport
    private fun mount(arabic: Boolean = false, scenario: String = "happy") {
        transport = StorefrontFlowTransport(scenario)
        compose.setContent {
            val application = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as Application
            model = androidx.compose.runtime.remember { StorefrontModel(application, transport) { IsolatedCredential() } }
            Storefront(model)
        }
        compose.waitUntil(15000) { !model.loading }
        val locale = if(arabic) "ar" else "en"
        if(model.locale != locale) {
            compose.onNodeWithTag("tab-account").performClick()
            compose.onNodeWithTag("account-language-row").performScrollTo().performClick()
            compose.onNodeWithTag("account-language-$locale").performScrollTo().performClick()
            compose.waitUntil(15000) { model.locale == locale && !model.loading }
            compose.onNodeWithTag("account-home").performScrollTo().performClick()
        }
        compose.onNodeWithTag("tab-home").performClick()
        val productTag = "product-70000000-0000-0000-0000-000000000002"
        compose.onNodeWithTag("store-content").performScrollToNode(hasTestTag(productTag))
        compose.onAllNodesWithTag(productTag).onFirst().assertIsDisplayed()
    }
    @Test fun productScreenReturnsToCatalog() {
        mount()
        val product = "product-70000000-0000-0000-0000-000000000002"
        click(product)
        compose.onNodeWithTag("product-screen").assertIsDisplayed()
        compose.onNodeWithTag("tab-home").assertDoesNotExist()
        compose.onNodeWithTag("close-product").assertIsDisplayed().performClick()
        compose.onAllNodesWithTag(product).onFirst().assertIsDisplayed().performClick()
        compose.onNodeWithTag("product-detail-title").assertExists()
        InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK)
        compose.onAllNodesWithTag(product).onFirst().assertIsDisplayed()
        compose.onNodeWithTag("tab-home").assertIsSelected()
    }
    @Test fun configuredButtonRadiusCapture() {
        org.junit.Assume.assumeTrue(InstrumentationRegistry.getArguments().getString("radiusCapture") == "true")
        mount()
        compose.onNodeWithTag("tab-account").performClick()
        val button = compose.onNodeWithTag("customer-submit").performScrollTo()
        button.assertIsDisplayed()
        val token = model.config.brand.radiusToken.name
        val folder = File(InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir(null), "button-radius").apply { mkdirs() }
        val bitmap = button.captureToImage().asAndroidBitmap()
        File(folder, "$token-primary.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        val screen = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
        File(folder, "$token-account.png").outputStream().use { screen.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
    private fun click(tag: String) {
        if(tag=="delivery-options" && compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isEmpty())compose.onNodeWithTag("cart-checkout").performClick()
        if(tag.startsWith("product-"))compose.onNodeWithTag("store-content").performScrollToNode(hasTestTag(tag))
        val node = if(tag.startsWith("product-"))compose.onAllNodesWithTag(tag)[0] else compose.onNodeWithTag(tag)
        if (tag !in listOf("close-product","cart-checkout","add-to-bag")) node.performScrollTo()
        node.performClick()
    }
    private fun login() {
        compose.onNodeWithTag("tab-account").performClick()
        compose.onNodeWithTag("account-sign-in").performScrollTo().performClick()
        compose.onNodeWithTag("customer-identifier").performScrollTo().performTextInput("native-fixture@example.test")
        compose.onNodeWithTag("customer-password").performScrollTo().performTextInput("test-only-password")
        click("customer-submit")
        compose.waitUntil(10000) { !model.shopping.busy }
    }
    private fun variant() {
        assertNotNull(model.shopping.customer)
        compose.onNodeWithTag("tab-home").performClick()
        click("product-70000000-0000-0000-0000-000000000002")
        click("variant-70000000-0000-0000-0000-000000000010")
    }
    private fun cart() {
        click("add-to-bag")
        compose.waitUntil(10000) { !model.shopping.busy && model.shopping.cart?.items?.isNotEmpty() == true }
        click("close-product")
        compose.onNodeWithTag("tab-cart").performClick()
    }
    private fun review() {
        click("delivery-options"); click("review-order")
        compose.onNodeWithTag("place-order").performScrollTo().assertIsEnabled()
        assertEquals(0, transport.placed)
        compose.onNodeWithTag("order-confirmation").assertDoesNotExist()
    }
    private fun screenshot(name: String) {
        compose.waitForIdle()
        val i=InstrumentationRegistry.getInstrumentation()
        i.waitForIdleSync()
        i.uiAutomation.waitForIdle(200,3000)
        val dir=File(i.targetContext.getExternalFilesDir(null),"flow-verification").apply { mkdirs() }
        val image=i.uiAutomation.takeScreenshot()
        try { File(dir,"$name.png").outputStream().use { image.compress(Bitmap.CompressFormat.PNG,100,it) } } finally { image.recycle() }
    }
    @Test fun accountHomePreview() = accountHomePreview(false)
    @Test fun previewParityScreens() {
        mount()
        screenshot("parity-home")
        for (tab in listOf("categories", "deals", "account")) {
            compose.onNodeWithTag("tab-$tab").performClick()
            screenshot("parity-$tab")
        }
        click("account-notifications"); screenshot("parity-notifications")
        compose.onNodeWithText("My account").performScrollTo().performClick()
        compose.onNodeWithText("App settings").performScrollTo().performClick(); screenshot("parity-settings")
        compose.onNodeWithText("My account").performScrollTo().performClick()
        login(); screenshot("parity-account-customer")
        for (screen in listOf("addresses", "orders")) {
            click("account-$screen"); screenshot("parity-$screen"); click("account-home")
        }
        variant()
        compose.waitUntil(10000) { model.selectedProduct?.id == "70000000-0000-0000-0000-000000000010" }
        screenshot("parity-product-variant")
        cart(); screenshot("parity-cart")
        review(); screenshot("parity-checkout")
        assertEquals(0, transport.placed)
    }
    @Test fun arabicAccountHomePreview() = accountHomePreview(true)
    private fun accountHomePreview(arabic: Boolean) {
        mount(arabic)
        compose.onNodeWithTag("tab-account").performClick()
        compose.onNodeWithTag("account-sign-in").performScrollTo().assertExists()
        val first=compose.onNodeWithTag("account-sign-in").fetchSemanticsNode().boundsInRoot
        val second=compose.onNodeWithTag("account-register").fetchSemanticsNode().boundsInRoot
        assertEquals(first.width,second.width,1f)
        screenshot(if(arabic) "account-guest-ar" else "account-guest-en")
        login()
        compose.waitUntil(10000) { model.shopping.customer != null && !model.shopping.busy }
        compose.onNodeWithTag("account-addresses").performScrollTo().assertExists()
        screenshot(if(arabic) "account-customer-ar" else "account-customer-en")
        compose.onNodeWithTag("account-help").performScrollTo().performClick()
        compose.onNodeWithTag("assistant-input").assertExists()
    }
    @Test fun lightCartCheckout() = lightCartCheckout(false)
    @Test fun arabicLightCartCheckout() = lightCartCheckout(true)
    private fun lightCartCheckout(arabic:Boolean) {
        mount(arabic);login();variant();cart()
        screenshot(if(arabic)"light-cart-ar" else "light-cart-en")
        review()
        compose.onNodeWithTag("checkout-total").assertTextContains(if(arabic)"٣٠٫٠٠" else "30.00",substring=true)
        screenshot(if(arabic)"light-checkout-ar" else "light-checkout-en")
        click("place-order")
        compose.waitUntil(10000){model.shopping.detail!=null&&!model.shopping.busy}
        assertEquals(1,transport.placed)
        compose.onNodeWithTag("order-confirmation").assertExists()
    }
    @Test fun cartCouponAndSaveForLater() {
        mount();login();variant();cart()
        click("cart-coupon")
        compose.onNodeWithTag("cart-coupon-input").performTextInput("SAVE5")
        click("cart-coupon-apply")
        compose.waitUntil(10000){model.shopping.cart?.coupon_code=="SAVE5"&&!model.shopping.busy}
        assertEquals("20.00",model.shopping.cart?.itemsTotal)
        compose.onNodeWithContentDescription("Close").performClick()
        click("cart-save-70000000-0000-0000-0000-000000000010")
        compose.waitUntil(10000){model.shopping.cart?.items?.isEmpty()==true&&!model.shopping.busy}
        assertEquals(listOf("70000000-0000-0000-0000-000000000010"),transport.saved)
        compose.onNodeWithTag("cart-empty").assertExists()
    }
    @Test fun failedSaveKeepsCartItem() {
        mount(scenario="save-failed");login();variant();cart()
        click("cart-save-70000000-0000-0000-0000-000000000010")
        compose.waitUntil(10000){model.shopping.error!=null&&!model.shopping.busy}
        assertEquals(1,model.shopping.cart?.items?.size)
        assertTrue(transport.saved.isEmpty())
        compose.onNodeWithTag("cart-checkout").assertIsEnabled()
    }
    private fun complete(arabic: Boolean) {
        mount(arabic); login(); variant(); cart(); review()
        compose.onNodeWithTag("checkout-total").assertTextContains(if(arabic)"٣٠٫٠٠" else "30.00",substring=true)
        compose.onNodeWithText(if(arabic) "الدفع عند الاستلام" else "Cash on delivery").assertExists()
        compose.onNodeWithTag("quote-expiry").assertTextContains(if(arabic) "٢٠٣٠" else "2030",substring=true)
        screenshot(if(arabic) "android-checkout-ar" else "android-checkout-en")
        click("place-order")
        compose.waitUntil(10000) { model.shopping.detail != null && !model.shopping.busy }
        compose.onNodeWithTag("order-confirmation").performScrollTo().assertTextEquals(if(arabic) "طلب #42" else "Order #42")
        assertEquals(1,transport.placed)
        compose.onNodeWithText(if(arabic) "تحديث الحالة" else "Refresh status").performScrollTo().performClick()
        compose.waitUntil(10000) { model.shopping.detail?.order?.status == "delivered" }
        compose.onNodeWithTag("order-status").performScrollTo().assertTextEquals(if(arabic) "تم التوصيل" else "Delivered")
        compose.onNodeWithTag("order-date").assertTextContains(if(arabic) "أكتوبر" else "Oct",substring=true)
        compose.onNodeWithTag("order-history-70000000-0000-0000-0000-000000000009").assertTextContains(if(arabic) "تم استلام الطلب" else "Order placed",substring=true)
        screenshot(if(arabic) "android-tracking-ar" else "android-tracking-en")
        compose.onNodeWithTag("tab-account").performClick()
        compose.onNodeWithTag("order-list-status-70000000-0000-0000-0000-000000000007",useUnmergedTree=true).assertTextContains(if(arabic) "تم استلام الطلب" else "Order placed",substring=true)
        compose.onNodeWithTag("order-list-date-70000000-0000-0000-0000-000000000007",useUnmergedTree=true).assertTextContains(if(arabic) "أكتوبر" else "Oct",substring=true)
        compose.onNodeWithTag("account-language-row").performScrollTo().performClick()
        compose.onNodeWithTag(if(arabic) "account-language-en" else "account-language-ar").performScrollTo().performClick()
        compose.waitUntil(10000) { !model.loading }
        compose.onNodeWithTag("account-home").performScrollTo().performClick()
        compose.onNodeWithTag("order-list-status-70000000-0000-0000-0000-000000000007",useUnmergedTree=true).assertTextContains(if(arabic) "Order placed" else "تم استلام الطلب",substring=true)
        compose.onNodeWithTag("order-list-date-70000000-0000-0000-0000-000000000007",useUnmergedTree=true).assertTextContains(if(arabic) "Oct" else "أكتوبر",substring=true)
        compose.onNodeWithTag("account-language-row").performScrollTo().performClick()
        compose.onNodeWithTag(if(arabic) "account-language-ar" else "account-language-en").performScrollTo().performClick()
        compose.waitUntil(10000) { !model.loading && !model.shopping.busy }
        compose.onNodeWithTag("account-home").performScrollTo().performClick()
        compose.onNodeWithText(if(arabic) "تسجيل الخروج" else "Sign out").performScrollTo().performClick()
        compose.waitUntil(10000) { model.shopping.customer == null }
        compose.onNodeWithTag("account-sign-in").assertExists()
        assertTrue(transport.routes.contains("cart/items"))
        assertTrue(transport.routes.any { it.endsWith("/family") })
    }
    @Test fun assistantProductCartAndCheckout()=assistantFlow(false)
    @Test fun arabicAssistantProductCartAndCheckout()=assistantFlow(true)
    private fun assistantFlow(arabic:Boolean) {
        mount(arabic);login()
        compose.onNodeWithTag("tab-home").performClick()
        compose.onNodeWithTag("open-assistant").performClick()
        compose.waitUntil(10000){!model.shopping.busy}
        compose.onNodeWithTag("assistant-input").performTextInput("Show apples")
        compose.onNodeWithTag("assistant-send").performClick()
        compose.waitUntil(10000){model.shopping.assistant.turns.lastOrNull()?.reply?.text?.isNotEmpty()==true}
        compose.waitUntil(10000){!model.shopping.assistant.busy && !model.shopping.busy}
        click("assistant-add-70000000-0000-0000-0000-000000000010")
        compose.waitUntil(10000){!model.shopping.busy && model.shopping.cart?.items?.isNotEmpty()==true}
        screenshot(if(arabic)"assistant-ar" else "assistant-en")
        compose.onNodeWithTag("assistant-input").performTextInput("Checkout")
        compose.onNodeWithTag("assistant-send").performClick()
        compose.waitUntil(10000){!model.assistantPresented}
        screenshot(if(arabic)"assistant-cart-ar" else "assistant-cart-en")
        click("delivery-options")
        assertEquals(0,transport.placed)
        compose.onNodeWithTag("place-order").assertDoesNotExist()
        assertEquals(2,transport.routes.count{it=="assistant/chat"})
        click("review-order")
        compose.onNodeWithTag("place-order").performScrollTo().assertIsEnabled()
        assertEquals(0,transport.placed)
        screenshot(if(arabic)"assistant-checkout-ar" else "assistant-checkout-en")
    }
    @Test fun interruptedAssistantNeverOpensCheckout() {
        mount(scenario="assistant-interrupted")
        compose.onNodeWithTag("open-assistant").performClick()
        compose.waitUntil(10000){!model.shopping.busy}
        compose.onNodeWithTag("assistant-input").performTextInput("Checkout")
        compose.onNodeWithTag("assistant-send").performClick()
        compose.waitUntil(10000){model.shopping.assistant.turns.lastOrNull()?.interrupted==true}
        assertTrue(model.assistantPresented);assertEquals(0,transport.placed)
    }
    @Test fun assistantStopAndSessionReset() {
        mount(scenario="assistant-slow")
        compose.onNodeWithTag("open-assistant").performClick()
        compose.waitUntil(10000){!model.shopping.busy}
        compose.onNodeWithTag("assistant-input").performTextInput("Show apples")
        compose.onNodeWithTag("assistant-send").performClick()
        compose.onNodeWithTag("assistant-stop").performClick()
        compose.waitUntil(10000){!model.shopping.assistant.busy}
        assertTrue(model.shopping.assistant.turns.last().interrupted)
        compose.onNodeWithTag("assistant-close").performClick();login()
        compose.waitUntil(10000){model.shopping.customer!=null}
        assertTrue(model.shopping.assistant.turns.isEmpty())
    }
    @Test fun completeEnglishStorefrontFlow() = complete(false)
    @Test fun completeArabicStorefrontFlow() = complete(true)
    @Test fun rejectedLoginRetainsFormAndCanRetry() {
        mount(scenario="invalid-login");login()
        compose.onNodeWithTag("commerce-error").assertTextEquals("Invalid credentials")
        compose.onNodeWithTag("customer-identifier").assertTextContains("native-fixture@example.test")
        click("customer-submit");compose.waitUntil(10000) { model.shopping.customer != null && !model.shopping.busy }
    }
    @Test fun soldOutVariantCannotBeAdded() {
        mount(scenario="sold-out");login();variant()
        compose.onNodeWithTag("add-to-bag").assertIsDisplayed().assertIsNotEnabled()
        assertFalse(transport.added)
    }
    @Test fun outsideDeliveryAreaIsRejected() {
        mount(scenario="outside-area");login();variant();cart()
        compose.onNodeWithTag("tab-account").performClick()
        compose.onNodeWithTag("account-addresses").performScrollTo().performClick()
        compose.onNodeWithText("Fixture delivery street",substring=true).performScrollTo().performClick()
        compose.waitUntil(10000) { model.shopping.error != null }
        compose.onNodeWithTag("commerce-error").assertTextContains("outside our delivery area",substring=true)
        assertEquals(0,transport.placed)
    }
    @Test fun changedPriceRequiresNewReview() {
        mount(scenario="changed-price");login();variant();cart();review();click("place-order")
        compose.waitUntil(10000) { !model.shopping.busy && model.shopping.error != null }
        compose.onNodeWithTag("place-order").assertDoesNotExist()
        assertNull(model.shopping.quote);assertNull(model.shopping.detail)
    }
    @Test fun interruptedCheckoutUsesSameKeyOnRetry() {
        mount(scenario="interrupted-checkout");login();variant();cart();review();click("place-order")
        compose.waitUntil(10000) { model.shopping.uncertainCheckout && !model.shopping.busy }
        click("place-order")
        compose.waitUntil(10000) { model.shopping.detail != null && !model.shopping.busy }
        assertEquals(2,transport.placed);assertEquals(1,transport.checkoutKeys.distinct().size)
    }
    @Test fun expiredSessionReturnsToSignIn() {
        mount(scenario="expired-session");login()
        compose.onNodeWithTag("account-orders").performScrollTo().performClick()
        compose.onNodeWithText("Refresh orders").performScrollTo().performClick()
        compose.waitUntil(10000) { model.shopping.customer == null }
        compose.onNodeWithTag("account-sign-in").assertExists();assertNull(model.shopping.quote)
    }
    @Test fun cartQuantityAndRemoval() {
        mount();login();variant();cart()
        compose.onNodeWithTag("cart-increase-70000000-0000-0000-0000-000000000010").performScrollTo().performClick()
        compose.waitUntil(10000) { model.shopping.cart?.subtotal == "50.00" }
        compose.onNodeWithTag("cart-decrease-70000000-0000-0000-0000-000000000010").performScrollTo().performClick()
        compose.waitUntil(10000) { model.shopping.cart?.subtotal == "25.00" }
        compose.onNodeWithTag("cart-decrease-70000000-0000-0000-0000-000000000010").performScrollTo().performClick()
        compose.waitUntil(10000) { model.shopping.cart?.items?.isEmpty() == true }
        compose.onNodeWithText("Your bag is empty").assertExists()
        compose.onNodeWithTag("delivery-options").assertDoesNotExist()
    }
    @Test fun stockShortfallBlocksCheckout() {
        mount(scenario="stock-shortfall");login();variant();cart()
        compose.onNodeWithTag("cart-checkout").assertIsNotEnabled()
        compose.onNodeWithTag("place-order").assertDoesNotExist();assertEquals(0,transport.placed)
    }

}
