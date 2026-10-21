package com.rocento.mobile

import java.net.URLEncoder
import kotlinx.serialization.*
import kotlinx.serialization.json.*

@Serializable
data class Product(
    val id: String,
    val name: String,
    val description: String,
    val price: String,
    val currency: String,
    val nameAr: String? = null,
    val descriptionAr: String? = null,
    val symbol: String? = null,
    @SerialName("in_stock") val inStock: Boolean,
    @SerialName("product_type") val productType: String = "simple",
    @SerialName("media_ids") val mediaIds: List<String> = emptyList(),
    val active: Boolean? = null,
    val attributes: JsonObject? = null,
    @SerialName("catalog_offer") val catalogOffer: CatalogOffer? = null,
    val unit: String? = null,
) {
    val thumbnail get() = (attributes?.get("demo-thumbnail") as? JsonPrimitive)?.contentOrNull ?: mediaIds.firstOrNull()
    val displayPrice: String get() { val o=catalogOffer ?: return price; val original=o.original_price.toBigDecimalOrNull(); val discount=o.discounted_price.toBigDecimalOrNull(); return if(o.product_id==id && o.currency==currency && original!=null && price.toBigDecimalOrNull()?.compareTo(original)==0 && discount!=null && discount.signum()>=0 && discount<original) o.discounted_price else price }
    fun title(locale: String) = if (locale == "ar") nameAr ?: name else name

    fun detail(locale: String) = if (locale == "ar") descriptionAr ?: description else description
}

@Serializable data class CatalogOffer(val product_id:String,val currency:String,val original_price:String,val discounted_price:String)

@Serializable
data class Category(
    val id: String,
    val name: String,
    val slug: String,
    val thumbnail: String? = null,
    val nameAr: String? = null,
    val parent_id: String? = null,
) {
    fun title(locale: String) = if (locale == "ar") nameAr ?: name else name
}

@Serializable
data class CatalogFixture(
    val merchantId: String,
    val categories: List<Category>,
    val products: List<Product>,
)

interface CatalogServing {
    suspend fun categories(locale: String): List<Category>

    suspend fun products(category: String?, locale: String): List<Product>

    suspend fun product(id: String, locale: String): Product
    suspend fun attributes(locale: String): List<CatalogAttribute> = emptyList()
    suspend fun browse(category: String, filters: CatalogFilters, offset: Int, locale: String): CatalogPage {
        require(filters.valid)
        val matches = products(category.takeIf { it.isNotEmpty() }, locale).filter {
            (filters.query.isEmpty() || it.title(locale).contains(filters.query, ignoreCase = true)) &&
            (!filters.inStock || it.inStock) &&
            (it.price.toDoubleOrNull() ?: 0.0) >= (filters.minimum.toDoubleOrNull() ?: 0.0) &&
            (it.price.toDoubleOrNull() ?: 0.0) <= (filters.maximum.toDoubleOrNull() ?: Double.POSITIVE_INFINITY)
        }.let { list -> when(filters.sort) {
            "price_asc" -> list.sortedBy { it.price.toDoubleOrNull() ?: 0.0 }
            "price_desc" -> list.sortedByDescending { it.price.toDoubleOrNull() ?: 0.0 }
            "name_desc" -> list.sortedByDescending { it.title(locale) }
            "name_asc" -> list.sortedBy { it.title(locale) }
            else -> list
        } }
        return CatalogPage(matches.drop(offset.coerceAtLeast(0)).take(24), matches.size)
    }
}

private val fixtureJson = Json { ignoreUnknownKeys = true }

class FixtureCatalog(data: String, identity: AppIdentity) : CatalogServing {
    private val fixture = fixtureJson.decodeFromString<CatalogFixture>(data)

    init {
        require(fixture.merchantId == identity.merchantId)
    }

    override suspend fun categories(locale: String) = fixture.categories

    override suspend fun products(category: String?, locale: String): List<Product> {
        if (
            category != null && fixture.categories.none { it.id == category || it.slug == category }
        )
            throw MobileFailure("Unknown category")
        return fixture.products
    }

    override suspend fun product(id: String, locale: String) =
        fixture.products.firstOrNull { it.id == id } ?: throw MobileFailure("Unknown product")
}

class CommerceCatalog(
    private val identity: AppIdentity,
    private val transport: HTTPTransport = OkHTTPTransport(),
) : CatalogServing {
    private val json = Json { ignoreUnknownKeys = true }

    private suspend inline fun <reified T> get(path: String, locale: String): T {
        // Public commerce reads use the compiled merchant installation, not config credentials.
        val response =
            transport.get(
                identity.commerceBase.trimEnd('/') + "/" + path,
                mapOf("X-Storefront-Locale" to if (locale == "ar") "ar" else "en"),
                2000000,
            )
        if (response.status != 200) throw MobileFailure("Catalog unavailable")
        return json.decodeFromString(response.body.decodeToString())
    }

    override suspend fun categories(locale: String): List<Category> =
        get("v1/catalog/categories", locale)

    @Serializable private data class Results(val hits: List<Product>)

    override suspend fun products(category: String?, locale: String): List<Product> {
        if(category?.startsWith("demo-feed-")==true) {
            val theme=get<JsonObject>("v1/theme/storefront",locale)
            val feed=demoFeed(theme,category.removePrefix("demo-feed-"))
            val response=get<JsonObject>(feed.path,locale)
            return json.decodeFromJsonElement<List<Product>>(response[if(feed.bestsellers) "products" else "hits"] ?: throw MobileFailure("Missing feed")).filter { it.active!=false }.take(feed.limit)
        }
        val id = category?.let {
            if (it.matches(Regex("[0-9a-f-]{36}"))) it
            else
                categories(locale).firstOrNull { c -> c.slug == it }?.id
                    ?: throw MobileFailure("Unknown category")
        }
        val query = id?.let { "&category_id=" + URLEncoder.encode(it, "UTF-8") }.orEmpty()
        return get<Results>("v1/search?q=$query", locale).hits
    }

    override suspend fun attributes(locale: String): List<CatalogAttribute> = get("v1/catalog/attribute-definitions", locale)
    override suspend fun browse(category: String, filters: CatalogFilters, offset: Int, locale: String): CatalogPage {
        require(filters.valid)
        val id = if (category.isEmpty()) "" else categories(locale).firstOrNull { it.id == category || it.slug == category }?.id ?: throw MobileFailure("Unknown category")
        return get("v1/search?" + filters.parameters(id, offset), locale)
    }
    override suspend fun product(id: String, locale: String): Product {
        if (!id.matches(Regex("[0-9a-f-]{36}"))) throw MobileFailure("Invalid product")
        return get("v1/catalog/products/$id", locale)
    }
}

@Serializable data class ProductFamily(val children: List<Product>)

data class CatalogFilters(val query: String = "", val minimum: String = "", val maximum: String = "", val inStock: Boolean = false, val sort: String = "relevance", val attributes: Map<String, List<String>> = emptyMap(), val attributeTypes: Map<String, String> = emptyMap()) {
    val valid: Boolean get() {
        val low = if (minimum.isEmpty()) 0.0 else minimum.toDoubleOrNull() ?: -1.0
        val high = if (maximum.isEmpty()) Double.POSITIVE_INFINITY else maximum.toDoubleOrNull() ?: -1.0
        val numericValid = attributes.all { (code, values) -> attributeTypes[code] !in listOf("integer", "decimal", "measurement", "price") || values.all { it.toDoubleOrNull()?.isFinite() == true } }
        return numericValid && query.length <= 120 && low.isFinite() && low >= 0 && high >= low && (maximum.isEmpty() || high.isFinite())
    }
    fun parameters(category: String, offset: Int): String {
        val values = mutableMapOf("q" to query, "category_id" to category, "offset" to offset.toString(), "limit" to "24")
        if (category.isEmpty()) values.remove("category_id")
        if (minimum.isNotEmpty()) values["min_price"] = minimum
        if (maximum.isNotEmpty()) values["max_price"] = maximum
        if (inStock) values["in_stock"] = "true"
        if (sort != "relevance") {
            values["sort_by"] = if (":" in sort) sort.substringBefore(":") else if (sort.startsWith("name_")) "name" else "price"
            values["sort_order"] = if (sort.endsWith("desc")) "desc" else "asc"
        }
        if (attributes.isNotEmpty()) values["attribute_filters"] = JsonObject(attributes.mapValues { (code, selections) -> JsonArray(selections.map { value ->
            when(attributeTypes[code]) {
                "boolean" -> JsonPrimitive(value == "true")
                "integer", "decimal", "measurement", "price" -> value.toDoubleOrNull()?.let { JsonPrimitive(it) } ?: JsonPrimitive(value)
                else -> JsonPrimitive(value)
            }
        }) }).toString()
        return values.entries.joinToString("&") { (key, value) -> "$key=${URLEncoder.encode(value, "UTF-8")}" }
    }
}
@Serializable data class CatalogPage(val hits: List<Product>, val total: Int, val facets: Map<String, Map<String, Int>> = emptyMap())

@Serializable data class CatalogAttribute(val attribute_code: String, val label: String, val input_type: String, val is_filterable: Boolean, val is_visible_on_front: Boolean, val options: List<Option> = emptyList(), val metadata: Metadata? = null) {
    @Serializable data class Option(val value: String, val label: String)
    @Serializable data class Metadata(val status: String? = null, val facetable: Boolean? = null, val display_order: Int? = null, val sortable: Boolean? = null)
    val visible get() = is_filterable && is_visible_on_front && metadata?.status != "disabled"
    val usesChoices get() = input_type in listOf("boolean", "select", "multiselect", "single_select", "multi_select") || (input_type in listOf("text", "textarea", "long_text") && metadata?.facetable == true)
    fun showsFilter(facets: Map<String, Int>?, selected: List<String>) = visible && (!usesChoices || metadata?.facetable != true || facets == null || choices(facets, selected).isNotEmpty())
    fun choices(facets: Map<String, Int>?, selected: List<String>): List<String> {
        val base = if(input_type == "boolean") listOf("true", "false") else if(options.isEmpty()) facets?.keys?.sorted() ?: emptyList() else options.map { it.value }
        return (base + selected).distinct().filter { metadata?.facetable != true || facets == null || (facets[it] ?: 0) > 0 || it in selected }
    }
}

internal data class DemoFeed(val path:String,val limit:Int,val bestsellers:Boolean)
internal fun demoFeed(theme:JsonObject,id:String):DemoFeed {
    val section=theme["configuration"]?.jsonObject?.get("pages")?.jsonObject?.get("home")?.jsonArray?.firstOrNull { it.jsonObject["id"]?.jsonPrimitive?.content==id && it.jsonObject["enabled"]?.jsonPrimitive?.booleanOrNull==true }?.jsonObject ?: throw MobileFailure("Unknown feed")
    val kind=section["component"]?.jsonPrimitive?.content
    require(kind in listOf("featured_products","product_collection","recommendations","best_sellers"))
    val s=section["settings"]!!.jsonObject
    val limit=(s["limit"]?.jsonPrimitive?.intOrNull ?: 8).coerceIn(1,24)
    fun text(key:String)=s[key]?.jsonPrimitive?.contentOrNull
    fun encode(value:String)=URLEncoder.encode(value,"UTF-8")
    if(kind=="best_sellers") { val period=text("period") ?: "last_month"; require(period in listOf("today","last_week","last_month","last_year")); return DemoFeed("v1/catalog/bestsellers?period=$period&limit=$limit",limit,true) }
    return DemoFeed("v1/search?q="+encode(text("query") ?: "")+(text("category")?.takeIf{it.isNotEmpty()}?.let{"&category_id="+encode(it)} ?: ""),limit,false)
}
