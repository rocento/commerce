package com.rocento.mobile

import com.rocento.mobile.contract.*
import java.net.URI
import java.security.MessageDigest
import kotlin.math.pow
import kotlinx.serialization.*
import kotlinx.serialization.json.*

class MobileFailure(val reason: String) : Exception(reason)

data class AppIdentity(
    val merchantId: String,
    val environment: String,
    val commerceBase: String,
    val runtime: String = "1.3.0",
) {
    init {
        require(
            merchantId.matches(
                Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"),
            ),
        )
        require(
            runtime.matches(
                Regex("(0|[1-9][0-9]{0,5})\\.(0|[1-9][0-9]{0,5})\\.(0|[1-9][0-9]{0,5})"),
            ),
        )
        require(environment in listOf("preview", "staging", "production"))
        for (base in listOf(commerceBase)) {
            val u = URI(base)
            require(
                u.scheme == "https" &&
                    u.host != null &&
                    u.userInfo == null &&
                    u.query == null &&
                    u.fragment == null &&
                    u.path in listOf("", "/", "/api", "/api/"),
            )
        }
    }

    val cacheKey
        get() = digest("$merchantId|$environment|android|$commerceBase".toByteArray())
}

fun digest(bytes: ByteArray) =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

val configJson = Json {
    ignoreUnknownKeys = false
    isLenient = false
    coerceInputValues = false
}

// Closed contract subset, guarded by the schema generator's keyword inventory.
class ConfigValidator(schemaText: String) {
    private val root = configJson.parseToJsonElement(schemaText).jsonObject

    private fun fail(): Nothing = throw MobileFailure("Invalid configuration")

    private fun shape(value: JsonElement, rule: JsonObject) {
        rule["\$ref"]?.jsonPrimitive?.content?.let { ref ->
            if (!ref.startsWith("#/\$defs/")) fail()
            shape(value, root["\$defs"]!!.jsonObject[ref.substringAfterLast('/')]!!.jsonObject)
            return
        }
        rule["oneOf"]?.jsonArray?.let { options ->
            if (options.count { runCatching { shape(value, it.jsonObject) }.isSuccess } != 1) fail()
            return
        }
        rule["enum"]?.jsonArray?.let { if (value !in it) fail() }
        fun int(key: String) = rule[key]?.jsonPrimitive?.int
        when (rule["type"]?.jsonPrimitive?.content) {
            "object" -> {
                val obj = value as? JsonObject ?: fail()
                val props = rule["properties"]?.jsonObject ?: JsonObject(emptyMap())
                if (rule["required"]?.jsonArray?.any { it.jsonPrimitive.content !in obj } == true)
                    fail()
                if (
                    obj.size < (int("minProperties") ?: 0) ||
                        obj.size > (int("maxProperties") ?: Int.MAX_VALUE)
                )
                    fail()
                for ((key, child) in obj) {
                    rule["propertyNames"]?.jsonObject?.let { shape(JsonPrimitive(key), it) }
                    val spec = props[key] ?: rule["additionalProperties"]
                    if (spec is JsonObject) shape(child, spec)
                    else if (spec == JsonPrimitive(false)) fail()
                }
            }
            "array" -> {
                val list = value as? JsonArray ?: fail()
                if (
                    list.size < (int("minItems") ?: 0) ||
                        list.size > (int("maxItems") ?: Int.MAX_VALUE)
                )
                    fail()
                if (rule["uniqueItems"] == JsonPrimitive(true) && list.distinct().size != list.size)
                    fail()
                list.forEach { shape(it, rule["items"]!!.jsonObject) }
            }
            "string" -> {
                val p = value as? JsonPrimitive ?: fail()
                if (!p.isString) fail()
                val text = p.content
                val count = text.codePointCount(0, text.length)
                if (count < (int("minLength") ?: 0) || count > (int("maxLength") ?: Int.MAX_VALUE))
                    fail()
                rule["pattern"]?.jsonPrimitive?.content?.let {
                    if (!Regex(it).containsMatchIn(text)) fail()
                }
            }
            "integer" -> {
                val p = value as? JsonPrimitive ?: fail()
                if (p.isString) fail()
                val n = p.longOrNull ?: fail()
                if (n < (int("minimum") ?: Int.MIN_VALUE) || n > (int("maximum") ?: Int.MAX_VALUE))
                    fail()
            }
            "boolean" -> {
                val p = value as? JsonPrimitive ?: fail()
                if (p.isString || p.booleanOrNull == null) fail()
            }
            else -> fail()
        }
    }

    fun decode(bytes: ByteArray, identity: AppIdentity, bundled: Boolean = false): MobileConfig {
        if (bytes.size > 131072) fail()
        // Replacement of malformed UTF-8 must not silently validate a changed payload.
        val text = Charsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(bytes)).toString()
        val element = configJson.parseToJsonElement(text)
        shape(element, root)
        val config = configJson.decodeFromJsonElement<MobileConfig>(element)
        if (config.tenantId != identity.merchantId) throw MobileFailure("Wrong merchant")
        if (!bundled && config.configVersion <= 0) fail()
        fun version(v: String): List<Int> {
            if (
                !v.matches(Regex("(0|[1-9][0-9]{0,5})\\.(0|[1-9][0-9]{0,5})\\.(0|[1-9][0-9]{0,5})"))
            )
                fail()
            return v.split('.').map(String::toInt)
        }
        val min = version(config.compatibility.minAndroidRuntime)
        val current = version(identity.runtime)
        val compare = current.zip(min).firstOrNull { it.first != it.second }
        if (min[0] != 1 || current[0] != 1 || (compare != null && compare.first < compare.second))
            throw MobileFailure("Incompatible runtime")
        val home=element.jsonObject["screens"]!!.jsonObject["home"]!!.jsonObject
        val banners=home["sections"]!!.jsonArray.any { section ->
            val props=section.jsonObject["props"]!!.jsonObject
            listOf("layout", "imageFit", "additionalImageAssetIds").any { props.containsKey(it) }
        }
        if(banners && (current[1]<3 || min[1]<3)) throw MobileFailure("Banner runtime required")
        val editorial=home.containsKey("layout") || home["sections"]!!.jsonArray.any { section ->
            val props=section.jsonObject["props"]!!.jsonObject
            listOf("headingKey","bodyKey","eyebrowKey","labelKey","appearance","limit","storefrontPath").any { it in props } || props["collectionId"]?.jsonPrimitive?.content?.startsWith("demo-feed-")==true
        }
        if(editorial && (current[1]<2 || min[1]<2)) throw MobileFailure("Editorial runtime required")
        val navigation = element.jsonObject["navigation"]!!.jsonObject
        val deals = navigation["tabs"]!!.jsonArray.any { it.jsonPrimitive.content == "deals" } ||
            navigation["icons"]?.jsonObject?.values?.any { it.jsonPrimitive.content == "deals" } == true ||
            home["sections"]!!.jsonArray.any { it.jsonObject["props"]?.jsonObject?.get("action")?.jsonObject?.get("tab")?.jsonPrimitive?.content == "deals" }
        if (deals && (current[1] < 2 || min[1] < 2)) throw MobileFailure("Deals runtime required")
        for (p in listOf(config.brand.light, config.brand.dark)) {
            for ((a, b) in
                listOf(p.onPrimary to p.primary, p.text to p.background, p.text to p.surface)) {
                if (contrast(a, b) < 4.5) fail()
            }
        }
        val tabs = config.navigation.tabs.map { it.name }
        if (
            !tabs.containsAll(listOf("home", "cart", "account")) ||
                ("wishlist" in tabs && !config.features.wishlist)
        )
            fail()
        val locales = config.localization.supportedLocales.map { it.name }
        if (
            config.localization.defaultLocale.name !in locales ||
                ("ar" in locales && !config.localization.rtlEnabled)
        )
            fail()
        val ids = mutableSetOf<String>()
        for (section in config.screens.home.sections) {
            if (!ids.add(section.id())) fail()
            for (locale in locales) for (key in section.messageKeys()) if (
                config.messages(locale)[key] == null
            )
                fail()
            if(section is RichText && section.props.action is ActionOpenTab && section.props.action.tab.name !in tabs) fail()
            if (
                section is HeroBanner &&
                    section.props.action is ActionOpenTab &&
                    section.props.action.tab.name !in tabs
            )
                fail()
        }
        return config
    }

    private fun contrast(a: String, b: String): Double {
        fun lum(c: String): Double {
            val rgb = c.drop(1).toInt(16)
            val cs =
                listOf(16, 8, 0)
                    .map { ((rgb shr it) and 255) / 255.0 }
                    .map { if (it <= 0.04045) it / 12.92 else ((it + 0.055) / 1.055).pow(2.4) }
            return cs[0] * 0.2126 + cs[1] * 0.7152 + cs[2] * 0.0722
        }
        val x = lum(a)
        val y = lum(b)
        return (maxOf(x, y) + 0.05) / (minOf(x, y) + 0.05)
    }
}

fun MobileConfig.locale(requested: String) =
    if (localization.supportedLocales.any { it.name == requested }) requested
    else localization.defaultLocale.name

fun MobileConfig.messages(locale: String) =
    (if (locale == "ar") localization.messages.ar else localization.messages.en) ?: emptyMap()

fun MobileConfig.text(key: String, locale: String) =
    messages(locale(locale))[key] ?: messages(localization.defaultLocale.name)[key] ?: key

fun Section.id(): String =
    when (this) {
        is HeroBanner -> id
        is ProductCarousel -> id
        is ProductGrid -> id
        is CategoryGrid -> id
        is RichText -> id
        is Spacer -> id
    }

fun Section.messageKeys(): List<String> =
    when (this) {
        is HeroBanner -> listOf(props.accessibilityLabelKey) + listOfNotNull(props.headingKey,props.bodyKey,props.eyebrowKey,props.labelKey)
        is ProductCarousel -> listOf(props.titleKey)
        is ProductGrid -> listOf(props.titleKey)
        is CategoryGrid -> listOf(props.titleKey)
        is RichText -> listOf(props.textKey) + listOfNotNull(props.headingKey,props.bodyKey,props.eyebrowKey,props.labelKey)
        is Spacer -> emptyList()
    }

