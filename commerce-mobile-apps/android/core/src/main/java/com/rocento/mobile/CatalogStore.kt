package com.rocento.mobile

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit

data class CatalogState(
    val products: List<Product> = emptyList(),
    val collections: Map<String,List<Product>> = emptyMap(),
    val categories: List<Category> = emptyList(),
    val variants: List<Product> = emptyList(),
    val selectedCategory: String? = null,
    val categoryProducts: List<Product> = emptyList(),
    val categoryFilters: CatalogFilters = CatalogFilters(),
    val categoryAttributes: List<CatalogAttribute> = emptyList(),
    val categoryFacets: Map<String,Map<String,Int>> = emptyMap(),
    val categoryTotal: Int = 0,
    val categoryHasMore: Boolean = false,
    val categoryLoading: Boolean = false,
    val categoryError: String? = null,
    val selectedProduct: Product? = null
)
class CatalogStore(private val catalog: CatalogServing, private val scope: CoroutineScope, locale: String = "en") {
    var locale = locale; private set
    private val mutableState = MutableStateFlow(CatalogState())
    val state = mutableState.asStateFlow()
    var onChange: (() -> Unit)? = null
    private fun copy(en: String, ar: String) = if(locale=="ar") ar else en
    var products: List<Product>
        get() = state.value.products
        private set(value) { mutableState.value=state.value.copy(products=value); onChange?.invoke() }
    var collections: Map<String,List<Product>>
        get() = state.value.collections
        private set(value) { mutableState.value=state.value.copy(collections=value); onChange?.invoke() }
    var categories: List<Category>
        get() = state.value.categories
        private set(value) { mutableState.value=state.value.copy(categories=value); onChange?.invoke() }
    var variants: List<Product>
        get() = state.value.variants
        private set(value) { mutableState.value=state.value.copy(variants=value); onChange?.invoke() }
    var selectedCategory: String?
        get() = state.value.selectedCategory
        private set(value) { mutableState.value=state.value.copy(selectedCategory=value); onChange?.invoke() }
    var categoryProducts: List<Product>
        get() = state.value.categoryProducts
        private set(value) { mutableState.value=state.value.copy(categoryProducts=value); onChange?.invoke() }
    var categoryFilters: CatalogFilters
        get() = state.value.categoryFilters
        set(value) { if(value==categoryFilters)return; mutableState.value=state.value.copy(categoryFilters=value); onChange?.invoke(); scheduleCategoryFilters() }
    var categoryAttributes: List<CatalogAttribute>
        get() = state.value.categoryAttributes
        private set(value) { mutableState.value=state.value.copy(categoryAttributes=value); onChange?.invoke() }
    var categoryFacets: Map<String,Map<String,Int>>
        get() = state.value.categoryFacets
        private set(value) { mutableState.value=state.value.copy(categoryFacets=value); onChange?.invoke() }
    var categoryTotal: Int
        get() = state.value.categoryTotal
        private set(value) { mutableState.value=state.value.copy(categoryTotal=value); onChange?.invoke() }
    var categoryHasMore: Boolean
        get() = state.value.categoryHasMore
        private set(value) { mutableState.value=state.value.copy(categoryHasMore=value); onChange?.invoke() }
    var categoryLoading: Boolean
        get() = state.value.categoryLoading
        private set(value) { mutableState.value=state.value.copy(categoryLoading=value); onChange?.invoke() }
    var categoryError: String?
        get() = state.value.categoryError
        private set(value) { mutableState.value=state.value.copy(categoryError=value); onChange?.invoke() }
    var selectedProduct: Product?
        get() = state.value.selectedProduct
        private set(value) { mutableState.value=state.value.copy(selectedProduct=value); onChange?.invoke() }
    private var categoryFilterJob: Job? = null
    private var categoryOffset = 0
    private var appliedCategoryFilters = CatalogFilters()
    private var categoryRequest = 0
    fun search(query: String) {
        selectedCategory = ""
        categoryFilters = CatalogFilters(query = query.trim().take(120))
        browseCategory()
    }

    fun category(id: String) {
        selectedCategory = id
        categoryFilters = CatalogFilters()
        categoryAttributes = emptyList(); categoryFacets = emptyMap()
        browseCategory()
    }
    fun closeCategory() { categoryFilterJob?.cancel(); categoryFilterJob = null; categoryRequest++; selectedCategory = null; categoryLoading = false }
    private fun scheduleCategoryFilters() {
        categoryFilterJob?.cancel()
        categoryRequest++ // Ignore responses for filters that have already changed.
        categoryLoading = false
        if (selectedCategory == null || !categoryFilters.valid) return
        categoryFilterJob = scope.launch {
            kotlinx.coroutines.delay(300)
            categoryFilterJob = null
            browseCategory()
        }
    }
    fun browseCategory(more: Boolean = false) {
        if (!more) { categoryFilterJob?.cancel(); categoryFilterJob = null }
        val id = selectedCategory ?: return
        if (!more && !categoryFilters.valid || more && (!categoryHasMore || categoryLoading || categoryFilters != appliedCategoryFilters)) return
        val request = ++categoryRequest
        val language = locale
        if (!more) { appliedCategoryFilters = categoryFilters; categoryProducts = emptyList(); categoryTotal = 0; categoryOffset = 0; categoryHasMore = false }
        val filters = appliedCategoryFilters
        val offset = categoryOffset
        categoryLoading = true
        categoryError = null
        scope.launch {
            try {
                val (definitions, page) = coroutineScope {
                    val definitions = async { catalog.attributes(language) }
                    val page = async { catalog.browse(id, filters, offset, language) }
                    definitions.await() to page.await()
                }
                if (request == categoryRequest && selectedCategory == id && locale == language) {
                    categoryAttributes = definitions.filter { it.is_visible_on_front && it.metadata?.status != "disabled" }.sortedBy { it.metadata?.display_order ?: 0 }
                    categoryFacets = page.facets
                    categoryProducts = (categoryProducts + page.hits.filter { it.active != false }).distinctBy { it.id }
                    categoryTotal = page.total
                    categoryOffset += page.hits.size
                    categoryHasMore = page.hits.isNotEmpty() && categoryOffset < page.total && categoryOffset <= 9999
                }
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                if (request == categoryRequest) categoryError = copy("Unable to load products. Please retry.", "تعذر تحميل المنتجات. يرجى المحاولة.")
            } finally { if (request == categoryRequest) categoryLoading = false }
        }
    }

    private var productRequest = 0
    fun dismissProduct() { productRequest++; selectedProduct=null; variants=emptyList() }
    suspend fun product(id: String, family: (suspend (String) -> List<Product>)? = null) {
        val request=++productRequest; val language=locale
        selectedProduct=null; variants=emptyList()
        try {
            val value=catalog.product(id,language)
            currentCoroutineContext().ensureActive()
            if(request!=productRequest || locale!=language)throw CancellationException()
            selectedProduct=value
            if(value.productType!="simple" && family!=null) {
                val children=family(id)
                currentCoroutineContext().ensureActive()
                if(request!=productRequest || locale!=language)throw CancellationException()
                variants=children
            }
        } catch(e: Exception) {
            if(request!=productRequest || locale!=language)throw CancellationException()
            throw e
        }
    }
    private var homeRequest=0
    suspend fun load(collectionIDs: List<String>) {
        val request=++homeRequest; val language=locale
        collections=collections.filterKeys { it in collectionIDs }
        suspend fun check() {
            currentCoroutineContext().ensureActive()
            if(request!=homeRequest || locale!=language)throw CancellationException()
        }
        // Children inherit the caller's UI dispatcher; only transport/decoding uses IO.
        coroutineScope {
            val permits=Semaphore(4)
            launch { permits.withPermit { val value=catalog.categories(language); check(); categories=value } }
            launch { permits.withPermit { val value=catalog.products(null,language); check(); products=value } }
            collectionIDs.distinct().forEach { id ->
                launch { permits.withPermit {
                    val value=catalog.products(id,language); check(); collections=collections+(id to value)
                } }
            }
        }
    }
    fun changeLocale(value: String) {
        if(value==locale)return
        closeCategory(); dismissProduct(); homeRequest++; locale=value
        categories=emptyList(); products=emptyList(); collections=emptyMap()
    }
}
