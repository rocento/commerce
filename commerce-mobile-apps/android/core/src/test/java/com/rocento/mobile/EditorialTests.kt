package com.rocento.mobile
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
class EditorialTests {
    private fun bytes(name:String)=javaClass.classLoader!!.getResourceAsStream(name)!!.readBytes()
    @Test fun fourMerchantSnapshotsAndRuntimeGuards() {
        val validator=ConfigValidator(bytes("schema.json").decodeToString())
        for((slug,count) in mapOf("grocery" to 7,"electronics" to 8,"jewelry" to 9,"pharmacy" to 6)) {
            val data=bytes("rocento-$slug.json")
            val raw=configJson.parseToJsonElement(data.decodeToString()).jsonObject
            val identity=AppIdentity(raw["tenantId"]!!.jsonPrimitive.content,"production","https://$slug.rocento.com/api")
            val config=validator.decode(data,identity,true)
            assertEquals(count,config.screens.home.sections.size)
            assertEquals("storefront",config.screens.home.layout?.name)
            assertTrue(bytes(config.brand.logoAssetId+".asset").isNotEmpty())
            config.screens.home.sections.filterIsInstance<com.rocento.mobile.contract.HeroBanner>().forEach { assertTrue(bytes(it.props.imageAssetId+".asset").isNotEmpty()); it.props.additionalImageAssetIds.orEmpty().forEach { id -> assertTrue(bytes(id+".asset").isNotEmpty()) } }
            assertThrows(Exception::class.java) { validator.decode(data,identity.copy(runtime="1.1.0"),true) }
            val key=config.screens.home.sections.first().messageKeys().last()
            val localization=raw["localization"]!!.jsonObject.toMutableMap()
            val messages=localization["messages"]!!.jsonObject.toMutableMap()
            messages["ar"]=JsonObject(messages["ar"]!!.jsonObject.toMutableMap().apply { remove(key) })
            localization["messages"]=JsonObject(messages)
            val missing=JsonObject(raw.toMutableMap().apply { put("localization",JsonObject(localization)) })
            assertThrows(Exception::class.java) { validator.decode(missing.toString().toByteArray(),identity,true) }
        }
    }
    @Test fun feedResolutionAndLimitsFailClosed() {
        val theme=configJson.parseToJsonElement("""{"configuration":{"pages":{"home":[{"id":"audio","enabled":true,"component":"product_collection","settings":{"query":"wireless & small","category":"audio-category","limit":6}},{"id":"best","enabled":true,"component":"best_sellers","settings":{"period":"today","limit":99}},{"id":"hidden","enabled":false,"component":"product_collection","settings":{}},{"id":"hero","enabled":true,"component":"editorial_hero","settings":{}}]}}}""").jsonObject
        val feed=demoFeed(theme,"audio")
        assertEquals(6,feed.limit);assertTrue(feed.path.contains("q=wireless+%26+small"));assertTrue(feed.path.contains("category_id=audio-category"))
        assertEquals(24,demoFeed(theme,"best").limit)
        listOf("hidden","missing","hero","https://evil.test").forEach { assertThrows(Exception::class.java) { demoFeed(theme,it) } }
    }
}
