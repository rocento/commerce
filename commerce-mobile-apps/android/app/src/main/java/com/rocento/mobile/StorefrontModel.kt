package com.rocento.mobile

import androidx.core.content.edit

import android.app.Application
import androidx.compose.runtime.*
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.rocento.mobile.contract.*
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

class StorefrontModel @JvmOverloads constructor(
    application: Application,
    private val transport: HTTPTransport = OkHTTPTransport(),
    private val credentialFactory: ((String) -> CredentialStorage)? = null,
) : AndroidViewModel(application) {
    val merchant = BuildConfig.MERCHANT
    val production = BuildConfig.PRODUCTION
    val identity =
        AppIdentity(
            if(production) BuildConfig.TENANT else "00000000-0000-0000-0000-00000000000$merchant",
            if(production) "production" else "preview",
            if(production) "https://${BuildConfig.STORE}.rocento.com/api" else "https://merchant-$merchant.example.test/api",
        )
    private fun credential(purpose: String): CredentialStorage =
        credentialFactory?.invoke(purpose) ?: SecureSession(getApplication<Application>(), identity, purpose)
    private val validator =
        ConfigValidator(application.assets.open("schema.json").bufferedReader().readText())
    private val fallback = application.assets.open(if(production) "rocento-${BuildConfig.STORE}.json" else "merchant-$merchant.json").readBytes()
    val integration = StorefrontIntegration(application, identity, fallback, validator, production, ::credential, transport)
    var quickPurchase by mutableStateOf(false)
    var brandAssets by mutableStateOf<Map<String,android.graphics.Bitmap>>(emptyMap())
    private val preferences = application.getSharedPreferences("storefront.preferences", android.content.Context.MODE_PRIVATE)
    private val analytics = CommerceAnalytics(identity,credential("analytics-consent"),transport)
    val settings = AppSettingsStore(preferences.getString("language",null) ?: if (java.util.Locale.getDefault().language == "ar") "ar" else "en", analytics.initiallyEnabled) { preferences.edit { putString("language",it) } }
    private val commerce = CommerceClient(identity,credential("customer-refresh"),credential("checkout-attempt"),transport,reorders=credential("reorder-task"))
    val catalog: CatalogServing = if(production) commerce else FixtureCatalog(
        application.assets.open("catalog-$merchant.json").bufferedReader().readText(), identity)
    val runtime = ShoppingRuntime(commerce,settings,viewModelScope,catalog,StorefrontNotificationPreferences(application))
    val shopping = ShoppingModel(runtime,analytics,viewModelScope)
    init { OrderPush.attach(commerce) }
    var config by mutableStateOf(validator.decode(fallback, identity, true))
        private set

    val catalogStore = runtime.catalog
    private fun catalogState(): CatalogState = catalogStore.state.value
    val products get()=catalogState().products
    val collections get()=catalogState().collections
    val categories get()=catalogState().categories
    val variants get()=catalogState().variants
    val selectedCategory get()=catalogState().selectedCategory
    val categoryProducts get()=catalogState().categoryProducts
    var categoryFilters: CatalogFilters
        get()=catalogState().categoryFilters
        set(value) { catalogStore.categoryFilters=value }
    val categoryAttributes get()=catalogState().categoryAttributes
    val categoryFacets get()=catalogState().categoryFacets
    val categoryTotal get()=catalogState().categoryTotal
    val categoryHasMore get()=catalogState().categoryHasMore
    val categoryLoading get()=catalogState().categoryLoading
    val categoryError get()=catalogState().categoryError
    var selectedProduct: Product?
        get()=catalogState().selectedProduct
        set(value) { if(value==null)catalogStore.dismissProduct() }
    var assistantPresented: Boolean
        get() { return shopping.session.navigation.state.value.assistantPresented }
        set(value) { shopping.session.navigation.presentAssistant(value) }
    var selectedTab: String
        get() { return shopping.session.navigation.state.value.tab }
        set(value) { shopping.session.navigation.selectTab(value) }
    val locale get(): String { return settings.state.value.locale }
    var problem by mutableStateOf<String?>(null)
        private set

    var loading by mutableStateOf(false)
        private set

    private var artworkJob: kotlinx.coroutines.Job? = null
    private val presentationCollections = PresentationCollections(catalogStore, viewModelScope)
    init { load() }

    fun copy(en: String, ar: String) = if (locale == "ar") ar else en

    fun toggleLanguage() {
        if (loading) return
        closeCategory()
        settings.selectLocale(if (locale == "ar") "en" else "ar")
        // Production catalog names are localized by the API, not stored bilingually.
        catalogStore.changeLocale(locale)
        load()
    }

    fun applyConfiguration(snapshot: ConfigSnapshot) {
        applyConfiguration(snapshot, forceCollections = false)
    }

    private fun applyConfiguration(snapshot: ConfigSnapshot, forceCollections: Boolean): kotlinx.coroutines.Deferred<Result<Unit>> {
        config = snapshot.config
        val collections = refreshPresentationCollections(forceCollections)
        artworkJob?.cancel()
        artworkJob = viewModelScope.launch {
            val decoded = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
        val assetIds = (listOf(snapshot.config.brand.logoAssetId) + snapshot.config.screens.home.sections
            .flatMap { (it as? HeroBanner)?.props?.let { p -> listOf(p.imageAssetId) + p.additionalImageAssetIds.orEmpty() } ?: emptyList() }).distinct()
        var total = 0
        val loaded = mutableMapOf<String, android.graphics.Bitmap>()
        for (id in assetIds) {
            val bytes = snapshot.assets[id] ?: runCatching {
                getApplication<Application>().assets.open("$id.asset").use { it.readBytes() }
            }.getOrNull() ?: continue
            if (total + bytes.size <= 20 * 1024 * 1024) {
                decodeBrandAsset(bytes)?.let { loaded[id] = it }
                total += bytes.size
            }
        }
                loaded
            }
            kotlinx.coroutines.currentCoroutineContext().ensureActive()
            brandAssets = decoded
        }
        return collections
    }

    private fun refreshPresentationCollections(force: Boolean = false) = presentationCollections.refresh(
        config.screens.home.sections.mapNotNull {
            when (it) {
                is ProductCarousel -> it.props.collectionId
                is ProductGrid -> it.props.collectionId
                else -> null
            }
        }, locale, force,
    )

    fun load() {
        loading = true
        viewModelScope.launch {
            problem = null
            try {
                val snapshot = integration.configuration.refresh(locale)
                if (production) shopping.client.setLocale(locale)
                applyConfiguration(snapshot, forceCollections = true).await().getOrThrow()
                if(production)shopping.event(CommerceEvent.HOME)
            } catch (e: MobileFailure) {
                problem =
                    copy(
                        "Unable to load this store. Please retry.",
                        "تعذر تحميل المتجر. يرجى المحاولة.",
                    )
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                problem =
                    copy(
                        "Unable to load this store. Please retry.",
                        "تعذر تحميل المتجر. يرجى المحاولة.",
                    )
            } finally {
                loading = false
            }
        }
    }

    fun search(query: String) { selectedTab="categories"; catalogStore.search(query) }
    fun category(id: String) { selectedTab="categories"; catalogStore.category(id); if(production)shopping.event(CommerceEvent.CATALOG) }
    fun closeCategory() = catalogStore.closeCategory()
    fun browseCategory(more: Boolean = false) = catalogStore.browseCategory(more)
    fun product(id: String) {
        problem = null
        viewModelScope.launch {
            try {
                val family: (suspend (String) -> List<Product>)? = if(production && shopping.selectedLocation.isNotEmpty()) { value -> shopping.client.family(value).children } else null
                catalogStore.product(id, family)
                if(production)shopping.event(CommerceEvent.PRODUCT)
                problem=null
            } catch(e: kotlinx.coroutines.CancellationException) { throw e }
            catch(e: Exception) { problem=copy("This product is unavailable.","هذا المنتج غير متاح.") }
        }
    }

    fun open(action: Action) {
        when (action) {
            is ActionOpenTab -> selectedTab = action.tab.name
            is ActionOpenCategory -> category(action.categoryId)
            is ActionOpenProduct -> product(action.productId)
        }
    }
}

