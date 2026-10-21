package com.rocento.mobile

import android.content.Intent
import android.graphics.Bitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.lifecycle.ViewModelProvider
import java.io.File
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Opt-in release verification against actual live merchant data; does not publish. */
@RunWith(AndroidJUnit4::class)
class Runtime12CaptureTests {
 @get:Rule val compose = createEmptyComposeRule()
 @Test fun captureAccountAndDeals() {
  val instrumentation=InstrumentationRegistry.getInstrumentation()
  org.junit.Assume.assumeTrue(InstrumentationRegistry.getArguments().getString("captureAccountDeals")=="true")
  val context=instrumentation.targetContext
  ActivityScenario.launch<MainActivity>(Intent(context,MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)).use { scenario ->
   lateinit var model:StorefrontModel
   scenario.onActivity { model=ViewModelProvider(it)[StorefrontModel::class.java] }
   compose.waitUntil(90000) { !model.loading }
   assertNull(model.problem)
   val originalLocale=model.locale
   val folder=File(context.filesDir,"account-deals-capture").apply { mkdirs() }
   fun capture(name:String) { compose.waitForIdle(); instrumentation.waitForIdleSync(); instrumentation.uiAutomation.takeScreenshot().let { bitmap -> File(folder,"$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG,100,it) } } }
   for(locale in listOf("en","ar")) {
    compose.onNodeWithTag("tab-account").performClick()
    compose.waitUntil(30000) { !model.shopping.busy }
    compose.onNodeWithTag("account-language-$locale").performScrollTo().performClick()
    compose.waitUntil(90000) { model.locale==locale && !model.loading && !model.shopping.busy }
    compose.onNodeWithTag("account-language-$locale").assertIsSelected()
    compose.onNodeWithTag("header-search").assertDoesNotExist()
    compose.onNodeWithTag("language-toggle").assertDoesNotExist()
    capture("preferences-$locale")
    compose.onNodeWithTag("store-content").performScrollToIndex(0)
    capture("account-$locale")
    compose.onNodeWithTag("tab-deals").performClick()
    compose.waitUntil(120000) {
     compose.onAllNodesWithTag("deals-loading").fetchSemanticsNodes().isEmpty() &&
      (compose.onAllNodesWithTag("deals-empty").fetchSemanticsNodes().isNotEmpty() ||
       compose.onAllNodesWithText(if(locale=="ar") "وفّر" else "Save",substring=true).fetchSemanticsNodes().isNotEmpty() ||
       compose.onAllNodesWithTag("deals-error").fetchSemanticsNodes().isNotEmpty())
    }
    compose.onNodeWithTag("deals-error").assertDoesNotExist()
    val offers=compose.onAllNodesWithText(if(locale=="ar") "وفّر" else "Save",substring=true).fetchSemanticsNodes().size
    if(offers>0) compose.waitUntil(60000) { compose.onAllNodesWithTag("merchant-image-ready",useUnmergedTree=true).fetchSemanticsNodes().size >= minOf(offers,2) }
    File(folder,"deals-$locale-status.txt").writeText(if(offers>0) "live offers" else "no eligible offers")
    capture("deals-$locale")
   }
   compose.onNodeWithTag("tab-account").performClick()
   compose.waitUntil(30000) { !model.shopping.busy }
   compose.onNodeWithTag("account-language-$originalLocale").performScrollTo().performClick()
   compose.waitUntil(90000) { model.locale==originalLocale && !model.loading }
   compose.onNodeWithTag("store-content").performScrollToIndex(0)
  }
 }
 @Test fun captureEveryLoadedSection() {
  val instrumentation=InstrumentationRegistry.getInstrumentation()
  val args=InstrumentationRegistry.getArguments()
  org.junit.Assume.assumeTrue(args.getString("runtime12Capture")=="true")
  val draft=args.getString("draft")=="true"
  val context=instrumentation.targetContext
  val intent=Intent(context,MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra("rocento-draft-preview",draft)
  ActivityScenario.launch<MainActivity>(intent).use { scenario ->
   lateinit var model:StorefrontModel
   scenario.onActivity { model=ViewModelProvider(it)[StorefrontModel::class.java] }
   compose.waitUntil(90000) { !model.loading && model.collections.isNotEmpty() }
   if(model.locale != "en") {
    compose.onNodeWithTag("tab-account").performClick()
    compose.onNodeWithTag("account-language-en").performScrollTo().performClick()
    compose.waitUntil(90000) { !model.loading && model.locale=="en" }
    compose.onNodeWithTag("tab-home").performClick()
   }
   if(!draft) {
    val codeFile=File(context.filesDir,"runtime12-code")
    if(codeFile.exists()) {
     val code=codeFile.readText().trim()
     compose.onNodeWithTag("tab-account").performClick()
     compose.onNodeWithTag("store-content").performScrollToNode(hasText("App connection"))
     compose.onNodeWithText("App connection",substring=false).performClick()
     compose.onNodeWithTag("store-content").performScrollToNode(hasTestTag("enrollment-code"))
     compose.onNodeWithTag("enrollment-code").performTextInput(code)
     compose.onNodeWithTag("store-content").performScrollToNode(hasTestTag("enrollment-connect"))
     compose.onNodeWithTag("enrollment-connect").performClick()
     codeFile.delete()
    }
    compose.waitUntil(90000) { !model.loading && model.config.configVersion==args.getString("version")!!.toInt() }
   }
   assertNull(model.problem)
   assertEquals("storefront",model.config.screens.home.layout?.name)
   assertEquals("1.2.0",model.config.compatibility.minAndroidRuntime)
   val expected=JSONObject(File(context.getExternalFilesDir(null),"runtime12-expected.json").readText())
   assertEquals(expected.getString("primary"),model.config.brand.light.primary)
   assertEquals(expected.getString("background"),model.config.brand.light.background)
   assertEquals(expected.getString("surface"),model.config.brand.light.surface)
   assertEquals(expected.getString("text"),model.config.brand.light.text)
   assertEquals(expected.getString("radius"),model.config.brand.radiusToken.name)
   assertEquals(expected.getString("density"),model.config.brand.density.name)
   val feeds=expected.getJSONObject("feeds")
   feeds.keys().forEach { id ->
    val ids=feeds.getJSONArray(id)
    assertEquals(id,(0 until ids.length()).map(ids::getString),model.collections[id].orEmpty().map { it.id })
   }
   if(!draft) assertEquals(args.getString("version")!!.toInt(),model.config.configVersion)
   compose.onNodeWithTag("tab-home").performClick()
   val folder=File(context.getExternalFilesDir(null),if(draft) "runtime12-draft" else "runtime12-published").apply { mkdirs() }
   fun capture(name:String) {
    compose.waitUntil(60000) { compose.onAllNodesWithTag("merchant-image-loading",useUnmergedTree=true).fetchSemanticsNodes().isEmpty() }
    compose.waitForIdle()
    val shot=instrumentation.uiAutomation.takeScreenshot()
    File(folder,"$name.png").outputStream().use { shot.compress(Bitmap.CompressFormat.PNG,100,it) };shot.recycle()
   }
   compose.onNodeWithTag("store-content").performScrollToIndex(0)
   capture("home")
   if(args.getString("homeOnly")!="true") model.config.screens.home.sections.forEachIndexed { index,section ->
    compose.onNodeWithTag("store-content").performScrollToIndex(index)
    if(section is com.rocento.mobile.contract.RichText) {
     val text=model.config.text(section.props.textKey,model.locale)
     assertTrue("Missing rich text: $text",compose.onAllNodesWithText(text,substring=false).fetchSemanticsNodes().isNotEmpty())
    }
    capture("section-${index+1}")
   }
   compose.onNodeWithTag("store-content").performScrollToIndex(0)
   capture("home")
   println("PASS runtime1.2 ${context.packageName} ${if(args.getString("homeOnly")=="true") "loaded home" else "${model.config.screens.home.sections.size} loaded sections"}; version=${model.config.configVersion}; draft=$draft")
  }
 }
}
