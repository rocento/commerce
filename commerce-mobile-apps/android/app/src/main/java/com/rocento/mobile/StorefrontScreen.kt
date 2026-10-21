package com.rocento.mobile

import androidx.core.graphics.toColorInt

import android.content.Context
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.*
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.gestures.snapping.rememberSnapFlingBehavior
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.*
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.rocento.mobile.contract.*

internal fun color(hex: String) = Color(hex.toColorInt())

internal fun symbol(product: Product) =
    mapOf(
        "apple" to "🍎",
        "avocado" to "🥑",
        "bread" to "🍞",
        "bag" to "👜",
        "shirt" to "👕",
        "cup" to "☕",
    )[product.symbol] ?: "📦"

internal fun tabIcon(tab: String) = when (tab) {
    "home" -> Icons.Outlined.Home
    "categories" -> StoreIcons.Categories
    "deals" -> StoreIcons.Deals
    "cart" -> Icons.Outlined.ShoppingCart
    "wishlist" -> Icons.Outlined.FavoriteBorder
    "location" -> Icons.Outlined.LocationOn
    else -> Icons.Outlined.Person
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun Storefront(model: StorefrontModel = viewModel()) {
    val shoppingState = shoppingUiState(model.shopping)
    val catalogState by model.catalogStore.state.collectAsStateWithLifecycle()
    val navigationState by model.shopping.session.navigation.state.collectAsStateWithLifecycle()
    val settingsState by model.settings.state.collectAsStateWithLifecycle()
    fun localized(en: String, ar: String) = if (settingsState.locale == "ar") ar else en
    StorefrontIntegrationEffects(model)
    LaunchedEffect(shoppingState.customer?.id) { OrderPush.session(shoppingState.customer?.id) }
    LaunchedEffect(OrderPush.pendingOrder) { if (OrderPush.pendingOrder != null) { model.selectedTab = "account" } }
    var categorySearch by remember { mutableStateOf("") }
    val config = model.config
    val preferencesContext = androidx.compose.ui.platform.LocalContext.current
    val preferences = remember { preferencesContext.getSharedPreferences("storefront.preferences", android.content.Context.MODE_PRIVATE) }
    val p = config.brand.light
    val colors =
            lightColorScheme(
                primary = color(p.primary),
                onPrimary = color(p.onPrimary),
                background = color(p.background),
                surface = color(p.surface),
                onSurface = color(p.text),
                onBackground = color(p.text),
            )
    val radius =
        when (config.brand.radiusToken.name) {
            "none" -> 0.dp
            "small" -> 8.dp
            "large" -> 28.dp
            else -> 18.dp
        }
    val gap = if (config.brand.density.name == "compact") 12.dp else 20.dp
    fun label(tab: String) =
        if (settingsState.locale == "ar")
            mapOf(
                "home" to "الرئيسية",
                "categories" to "الأقسام",
                "cart" to "السلة",
                "account" to "الحساب",
                "wishlist" to "المفضلة",
                "deals" to "العروض",
            )[tab] ?: tab
        else tab.replaceFirstChar { it.uppercase() }
    CompositionLocalProvider(
        LocalStorefrontButtonShape provides RoundedCornerShape(radius),
        LocalLayoutDirection provides
            if (settingsState.locale == "ar") LayoutDirection.Rtl else LayoutDirection.Ltr,
    ) {
        val screenState = rememberSaveableStateHolder()
        MaterialTheme(colorScheme = colors) {
            val contentScroll = androidx.compose.foundation.lazy.rememberLazyListState()
            val largeText = LocalDensity.current.fontScale > 1.5
            LaunchedEffect(navigationState.tab, catalogState.selectedCategory) { contentScroll.scrollToItem(0) }
            if (model.quickPurchase) QuickPurchaseSheet(model)
            if(navigationState.assistantPresented) {
                AssistantScreen(model.shopping.assistant,model.shopping,settingsState.locale,
                    close={model.assistantPresented=false},
                    navigate={model.assistantPresented=false;model.selectedTab=it},
                    openProduct={model.assistantPresented=false;model.product(it)})
            } else if (catalogState.selectedProduct != null && !model.quickPurchase) {
                val product = catalogState.selectedProduct!!
                val purchaseQuantity = shoppingState.cart?.items?.firstOrNull { it.product_id == product.id }?.quantity ?: 0
                var draftQuantity by remember(product.id) { mutableIntStateOf(1) }
                val shownQuantity = if (purchaseQuantity > 0) purchaseQuantity else draftQuantity
                val hasAddress = shoppingState.selectedLocation.isNotEmpty()
                val ready = product.productType == "simple"
                BackHandler { model.selectedProduct = null }
                Scaffold(
                    modifier = Modifier.testTag("product-screen"),
                    topBar = {
                        TopAppBar(
                            title = { Text(localized("Product", "المنتج")) },
                            navigationIcon = {
                                IconButton(
                                    onClick = { model.selectedProduct = null },
                                    modifier = Modifier.testTag("close-product"),
                                ) {
                                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = localized("Back", "رجوع"))
                                }
                            },
                            colors = TopAppBarDefaults.topAppBarColors(containerColor = color(p.background)),
                        )
                    },
                    bottomBar = {
                        Column {
                        if(model.production) {
                            Surface(color=color(p.background), shadowElevation=4.dp) {
                                Column(Modifier.padding(16.dp), verticalArrangement=Arrangement.spacedBy(12.dp)) {
                                    shoppingState.error?.let { Text(it,color=MaterialTheme.colorScheme.error) }
                                    shoppingState.notice?.let { Text(it) }
                                    Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(16.dp)) {
                                        Column(Modifier.weight(1f)) { Text(localized("Price per item","سعر القطعة"),style=MaterialTheme.typography.labelSmall); Text("${product.price} ${product.currency}",fontWeight=FontWeight.SemiBold) }
                                        Row(Modifier.border(1.dp,color(p.text).copy(alpha=.15f),RoundedCornerShape(8.dp)),verticalAlignment=Alignment.CenterVertically) {
                                            IconButton(onClick={if(purchaseQuantity>0) model.shopping.quantity(product.id,purchaseQuantity-1) else draftQuantity=maxOf(1,draftQuantity-1)},enabled=!shoppingState.busy && !shoppingState.uncertainCheckout) { Text("−",modifier=Modifier.semantics { contentDescription=localized("Decrease quantity","تقليل الكمية") }) }
                                            Text("$shownQuantity",modifier=Modifier.testTag("product-quantity"))
                                            IconButton(onClick={if(purchaseQuantity>0) model.shopping.quantity(product.id,purchaseQuantity+1) else draftQuantity=minOf(99,draftQuantity+1)},enabled=shownQuantity<99 && !shoppingState.busy && !shoppingState.uncertainCheckout && (!hasAddress || !ready || product.inStock)) { Icon(Icons.Default.Add,localized("Increase quantity","زيادة الكمية")) }
                                        }
                                    }
                                    if(purchaseQuantity == 0) Button(shape=LocalStorefrontButtonShape.current,onClick={if(!hasAddress || shoppingState.customer==null){model.selectedProduct=null;model.selectedTab="account"}else if(ready) model.shopping.add(product.id,draftQuantity)},enabled=!shoppingState.busy && (!hasAddress || (ready && product.inStock)) && !shoppingState.uncertainCheckout,modifier=Modifier.fillMaxWidth().heightIn(min=52.dp).testTag("add-to-bag")) { Text(if(!hasAddress) localized("Add to cart","إضافة إلى السلة") else if(!ready) localized("Select an option above","اختر أحد الخيارات أعلاه") else if(product.inStock) localized("Add to cart","إضافة إلى السلة") else localized("Out of stock","غير متوفر")) }
                                }
                            }
                        }
                    NavigationBar(containerColor = color(p.surface)) {
                        config.navigation.tabs.map { it.name }.forEach { tab ->
                            NavigationBarItem(
                                selected = navigationState.tab == tab,
                                onClick = { model.selectedProduct = null; model.selectedTab = tab },
                                icon = { Icon(tabIcon(config.navigation.icons?.get(tab)?.name ?: tab), contentDescription = null) },
                                label = { Text(label(tab)) },
                                colors =
                                    NavigationBarItemDefaults.colors(
                                        selectedIconColor = color(p.primary),
                                        selectedTextColor = color(p.primary),
                                        indicatorColor = color(p.primary).copy(alpha = 0.12f),
                                        unselectedIconColor = color(p.text),
                                        unselectedTextColor = color(p.text),
                                    ),
                                modifier = Modifier.testTag("tab-${tab}"),
                            )
                        }
                    }
                        }
                    },
                    containerColor = color(p.background),
                ) { productPadding ->
                    Column(
                        Modifier.fillMaxSize()
                            .padding(productPadding)
                            .verticalScroll(rememberScrollState())
                            .padding(24.dp),
                        verticalArrangement = Arrangement.spacedBy(24.dp),
                    ) {
                        if(model.production) MerchantImage(product.thumbnail?.let{model.shopping.client.imageURL(it)},Modifier.fillMaxWidth().height(220.dp)) else Text(
                            symbol(product),
                            fontSize = 100.sp,
                            modifier =
                                Modifier.fillMaxWidth()
                                    .padding(36.dp)
                                    .clearAndSetSemantics {},
                            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                        )
                        Text(
                            product.title(settingsState.locale),
                            style = MaterialTheme.typography.headlineLarge,
                            fontWeight = FontWeight.Bold,
                            modifier = Modifier.testTag("product-detail-title"),
                        )
                        Text(
                            "${product.price} ${product.currency}",
                            style = MaterialTheme.typography.titleLarge,
                        )
                        Text(product.detail(settingsState.locale))
                        if(!model.production || shoppingState.selectedLocation.isNotEmpty()) Text(
                            if (product.inStock) localized("Available", "متوفر")
                            else localized("Out of stock", "غير متوفر"),
                        )
                        if(model.production && config.features.wishlist && config.screens.product?.showWishlist != false) NativeWishlistSaveButton(model.shopping,product,settingsState.locale) {model.selectedProduct=null;model.selectedTab="account"}
                        if(model.production) {
                            model.problem?.let{Text(it,color=MaterialTheme.colorScheme.error);TextButton(onClick={model.product(product.id)}){Text(localized("Retry","إعادة المحاولة"))}}
                            if(shoppingState.selectedLocation.isEmpty()) {
                                Text(localized("Choose a covered delivery address to check available sizes and stock.","اختر عنواناً داخل منطقة التوصيل للتحقق من الأحجام والمخزون."))
                                Button(shape = LocalStorefrontButtonShape.current, onClick={model.selectedProduct=null;model.selectedTab="account"},modifier=Modifier.testTag("choose-product-address")){Text(localized("Choose delivery address","اختيار عنوان التوصيل"))}
                            } else if(product.productType=="simple") {
                                // The purchase controls remain visible in the bottom bar.
                            } else {
                                Text(localized("Choose your size or option","اختر الحجم أو النوع"))
                                catalogState.variants.forEach { variant ->
                                    OutlinedButton(shape = LocalStorefrontButtonShape.current, onClick={model.product(variant.id)},modifier=Modifier.testTag("variant-${variant.id}")){Text("${variant.title(settingsState.locale)} · ${variant.price} ${variant.currency}")}
                                }
                            }
                        } else Text(localized("Product preview · Checkout is not enabled yet","معاينة المنتج · الدفع غير مفعل بعد"),style=MaterialTheme.typography.bodySmall)
                        if(model.production) {
                            ProductRelationshipsView(model.shopping,listOf(product.id),"related",settingsState.locale) { model.product(it) }
                            ProductRelationshipsView(model.shopping,listOf(product.id),"upsell",settingsState.locale) { model.product(it) }
                            if(config.screens.product?.showCompare != false) ComparisonControls(model.shopping,product.id,settingsState.locale,{model.product(it)},{model.assistantPresented=true})
                            ReviewsView(model.shopping,product.id,settingsState.locale){model.selectedProduct=null;model.selectedTab="account"}
                        }

                    }
                }
            } else screenState.SaveableStateProvider("storefront") {
            Scaffold(
                containerColor = color(p.background),
                topBar = {
                    if (navigationState.tab != "account" && navigationState.tab != "cart") StoreHeader(model)

                },
                bottomBar = {
                    NavigationBar(containerColor = color(p.surface)) {
                        config.navigation.tabs.map { it.name }.forEach { tab ->
                            NavigationBarItem(
                                selected = navigationState.tab == tab,
                                onClick = { model.selectedTab = tab },
                                icon = { Icon(tabIcon(config.navigation.icons?.get(tab)?.name ?: tab), contentDescription = null) },
                                label = { Text(label(tab)) },
                                colors =
                                    NavigationBarItemDefaults.colors(
                                        selectedIconColor = color(p.primary),
                                        selectedTextColor = color(p.primary),
                                        indicatorColor = color(p.primary).copy(alpha = 0.12f),
                                        unselectedIconColor = color(p.text),
                                        unselectedTextColor = color(p.text),
                                    ),
                                modifier = Modifier.testTag("tab-${tab}"),
                            )
                        }
                    }
                },
            ) { padding ->
                BackHandler(enabled = navigationState.tab == "wishlist" && catalogState.selectedProduct == null) { model.selectedTab = "account" }
                BackHandler(enabled = navigationState.tab == "categories" && catalogState.selectedCategory != null && catalogState.selectedProduct == null) { model.closeCategory() }
                if(model.production && navigationState.tab=="cart") {
                    Box(Modifier.padding(padding).fillMaxSize().testTag("store-content")) {
                        CommerceView(model.shopping,settingsState.locale,navigationState.tab,config.features.wishlist,openProduct={model.product(it)},openWishlist={model.selectedTab="wishlist"},shop={model.selectedTab="categories"},toggleLanguage={model.toggleLanguage()},openHelp={model.assistantPresented=true})
                    }
                } else if (navigationState.tab == "deals") {
                    Box(Modifier.padding(padding).fillMaxSize().testTag("store-content")) { DealsView(model, p, radius) }
                } else LazyColumn(
                    state = contentScroll,
                    modifier = Modifier.padding(padding).fillMaxSize().testTag("store-content"),
                    contentPadding = PaddingValues(gap),
                    verticalArrangement = Arrangement.spacedBy(gap),
                ) {
                    if (model.loading) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
                    model.problem?.let { message ->
                        item {
                            Column {
                                Text(message)
                                TextButton(onClick = model::load) {
                                    Text(localized("Retry", "إعادة المحاولة"))
                                }
                            }
                        }
                    }
                    when (navigationState.tab) {
                        "home" -> {
                            if (config.screens.home.layout?.name != "storefront") item {
                                if(config.screens.home.layout?.name != "storefront") Text(
                                    localized(
                                        "YOUR EVERYDAY, BEAUTIFULLY CHOSEN",
                                        "اختيارات مميزة لكل يوم",
                                    ),
                                    style = MaterialTheme.typography.labelSmall,
                                    letterSpacing = if (settingsState.locale == "ar") 0.sp else 1.5.sp,
                                )
                            }
                            config.screens.home.sections.forEach { section ->
                                if (section is ProductGrid) {
                                    item(key = "${section.id}-title") { Text(config.text(section.props.titleKey, settingsState.locale), style = MaterialTheme.typography.titleLarge) }
                                    productRows(catalogState.collections[section.props.collectionId].orEmpty().take(section.props.limit ?: 24), model, p, radius,
                                        if (largeText) 1 else section.props.columns, section.id)
                                } else item(key = section.id()) {
                                when (section) {
                                    is HeroBanner -> if(section.props.layout != null) {
                                        Column {
                                            BoxWithConstraints(Modifier.fillMaxWidth()) {
                                                val images = listOf(section.props.imageAssetId) + section.props.additionalImageAssetIds.orEmpty()
                                                val portrait = section.props.layout?.name == "portrait"
                                                val ratio = if(portrait) 2f/3f else 3f
                                                val cardWidth = maxWidth * (if(images.size > 1) { if(portrait) 0.78f else 0.88f } else 1f)
                                                val bannerState = rememberLazyListState(initialFirstVisibleItemIndex = if(portrait && images.size >= 3) 1 else 0)
                                                LazyRow(state=bannerState, flingBehavior=rememberSnapFlingBehavior(bannerState), contentPadding=PaddingValues(horizontal=(maxWidth-cardWidth)/2), horizontalArrangement=Arrangement.spacedBy(12.dp), modifier=Modifier.height(cardWidth / ratio).testTag("hero-${section.id}")) {
                                                    items(images.size) { index ->
                                                        Box(Modifier.width(cardWidth).fillMaxHeight().clip(RoundedCornerShape(radius)).background(color(p.surface)).clickable { model.open(section.props.action) }.semantics { contentDescription = config.text(section.props.accessibilityLabelKey, settingsState.locale) + " · ${index+1}" }) {
                                                            model.brandAssets[images[index]]?.let { image ->
                                                                Image(image.asImageBitmap(), null, Modifier.fillMaxSize(), contentScale=if(section.props.imageFit?.name == "contain") androidx.compose.ui.layout.ContentScale.Fit else androidx.compose.ui.layout.ContentScale.Crop)
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                            if(section.props.appearance != null) EditorialCopy(model,p,section.props.headingKey,section.props.bodyKey,section.props.eyebrowKey,section.props.labelKey,section.props.action,section.props.storefrontPath,section.props.appearance?.name=="campaign")
                                        }
                                    } else if(section.props.appearance != null) {
                                        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(radius)).background(color(if(section.props.appearance?.name=="campaign") p.surface else p.background)).testTag("hero-${section.id}")) {
                                            model.brandAssets[section.props.imageAssetId]?.let { image -> Image(image.asImageBitmap(),config.text(section.props.accessibilityLabelKey,settingsState.locale),Modifier.fillMaxWidth().aspectRatio(image.width.toFloat()/image.height),contentScale=androidx.compose.ui.layout.ContentScale.Fit) }
                                            EditorialCopy(model,p,section.props.headingKey,section.props.bodyKey,section.props.eyebrowKey,section.props.labelKey,section.props.action,section.props.storefrontPath,section.props.appearance?.name=="campaign")
                                        }
                                    } else Card(
                                            onClick = { model.open(section.props.action) },
                                            shape = RoundedCornerShape(radius),
                                            colors =
                                                CardDefaults.cardColors(
                                                    containerColor = color(p.primary),
                                                    contentColor = color(p.onPrimary),
                                                ),
                                            modifier =
                                                Modifier.fillMaxWidth()
                                                    .testTag("hero-${section.id}")
                                                    .semantics(mergeDescendants = true) {
                                                        contentDescription =
                                                            config.text(
                                                                section.props.accessibilityLabelKey,
                                                                settingsState.locale,
                                                            )
                                                    },
                                        ) {
                                            Column(
                                                Modifier.padding(24.dp),
                                                verticalArrangement = Arrangement.spacedBy(20.dp),
                                            ) {
                                                Row(
                                                    Modifier.fillMaxWidth(),
                                                    verticalAlignment = Alignment.CenterVertically,
                                                    horizontalArrangement = Arrangement.spacedBy(14.dp),
                                                ) {
                                                    val heroImage = model.brandAssets[section.props.imageAssetId]
                                                    if (heroImage != null) {
                                                        Image(heroImage.asImageBitmap(), null, Modifier.weight(1f).height(96.dp), contentScale = androidx.compose.ui.layout.ContentScale.Fit)
                                                    } else {
                                                        Text(if (model.merchant == 1) "❧" else "◇", fontSize = 48.sp, modifier = Modifier.weight(1f).clearAndSetSemantics {})
                                                    }
                                                    Text(
                                                        "↗",
                                                        fontSize = 24.sp,
                                                        modifier = Modifier.clearAndSetSemantics {},
                                                    )
                                                }
                                                Text(
                                                    if (model.merchant == 1)
                                                        localized(
                                                            "A little fresher.\nA little better.",
                                                            "طازج أكثر.\nأفضل كل يوم.",
                                                        )
                                                    else
                                                        localized(
                                                            "Good things,\nfound here.",
                                                            "أشياء جميلة،\nتجدها هنا.",
                                                        ),
                                                    style = MaterialTheme.typography.headlineLarge,
                                                    fontWeight = FontWeight.SemiBold,
                                                )
                                                Text(
                                                    localized(
                                                        "Explore the collection",
                                                        "استكشف المجموعة",
                                                    ),
                                                    style = MaterialTheme.typography.labelLarge,
                                                )
                                            }
                                        }
                                    is ProductCarousel ->
                                        Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                                            Text(
                                                config.text(section.props.titleKey, settingsState.locale),
                                                style = MaterialTheme.typography.titleLarge,
                                                fontWeight = FontWeight.Bold,
                                                modifier = Modifier.semantics { heading() },
                                            )
                                            LazyRow(
                                                horizontalArrangement = Arrangement.spacedBy(gap),
                                            ) {
                                                items(
                                                    catalogState.collections[section.props.collectionId]
                                                        .orEmpty().take(section.props.limit ?: 24),
                                                    key = { it.id },
                                                ) { product ->
                                                    ProductCard(
                                                        product,
                                                        model,
                                                        p,
                                                        radius,
                                                        Modifier.width(
                                                            if (
                                                                LocalDensity.current.fontScale > 1.5
                                                            )
                                                                260.dp
                                                            else 172.dp,
                                                        ),
                                                    )
                                                }
                                            }
                                        }
                                    is ProductGrid -> Unit // Expanded as individually lazy rows above.
                                    is CategoryGrid ->
                                        Column(verticalArrangement=Arrangement.spacedBy(12.dp)) {
                                            Text(
                                                config.text(section.props.titleKey, settingsState.locale),
                                                style = MaterialTheme.typography.titleLarge,
                                            )
                                            if(section.props.appearance?.name=="tiles") {
                                                val ordered=section.props.categoryIds.mapNotNull { id -> catalogState.categories.firstOrNull { it.id==id || it.slug==id } }
                                                ordered.chunked(if(LocalDensity.current.fontScale>1.5) 1 else 2).forEach { row ->
                                                    Row(horizontalArrangement=Arrangement.spacedBy(12.dp),modifier=Modifier.fillMaxWidth()) {
                                                        row.forEach { category ->
                                                            Column(Modifier.weight(1f).clickable { model.category(category.id) }.testTag("category-${category.id}"),verticalArrangement=Arrangement.spacedBy(8.dp)) {
                                                                category.thumbnail?.let { MerchantImage(model.shopping.client.imageURL(it),Modifier.fillMaxWidth().aspectRatio(1f).clip(RoundedCornerShape(radius))) }
                                                                Text(category.title(settingsState.locale),fontSize=14.sp,fontWeight=FontWeight.SemiBold)
                                                            }
                                                        }
                                                        if(row.size==1 && LocalDensity.current.fontScale<=1.5) Box(Modifier.weight(1f))
                                                    }
                                                }
                                            } else catalogState.categories.filter { it.id in section.props.categoryIds || it.slug in section.props.categoryIds }.forEach { category -> TextButton(onClick={model.category(category.id)}) { Text(category.title(settingsState.locale)) } }
                                        }
                                    is RichText -> if(section.props.appearance!=null) {
                                        Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(radius)).background(color(if(section.props.appearance?.name=="campaign") p.surface else p.background))) {
                                            EditorialCopy(model,p,section.props.headingKey,section.props.bodyKey,section.props.eyebrowKey,section.props.labelKey,section.props.action,section.props.storefrontPath,section.props.appearance?.name=="campaign",textKey=section.props.textKey)
                                        }
                                    } else Text(config.text(section.props.textKey, settingsState.locale))
                                    is com.rocento.mobile.contract.Spacer ->
                                        Box(
                                            Modifier.height(
                                                when (section.props.size.name) {
                                                    "small" -> 8.dp
                                                    "large" -> 32.dp
                                                    else -> 16.dp
                                                },
                                            ),
                                        )
                                }
                            }
                            }
                        }
                        "categories" -> {
                            if (catalogState.selectedCategory != null) {
                                item { CategoryFiltersView(model) }
                                productRows(catalogState.categoryProducts, model, p, radius, if (largeText) 1 else 2, "category")
                                if (catalogState.categoryHasMore) item {
                                    TextButton(onClick = { model.browseCategory(true) }, enabled = !catalogState.categoryLoading) { Text(localized("Load more products", "عرض المزيد من المنتجات")) }
                                }
                            } else {
                                item {
                                    OutlinedTextField(value = categorySearch, onValueChange = { categorySearch = it },
                                        placeholder = { Text(localized("Search products", "البحث عن المنتجات")) },
                                        leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null) },
                                        singleLine = true, shape = RoundedCornerShape(radius),
                                        keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = androidx.compose.ui.text.input.ImeAction.Search),
                                        keyboardActions = androidx.compose.foundation.text.KeyboardActions(onSearch = { model.search(categorySearch) }),
                                        modifier = Modifier.fillMaxWidth().testTag("header-search"))
                                }
                                items(catalogState.categories.chunked(3), key = { it.first().id }) { row ->
                                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                        row.forEach { category ->
                                            Column(Modifier.weight(1f).clickable(role = Role.Button) { model.category(category.id) }.testTag("category-${category.id}"), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                                Box(Modifier.fillMaxWidth().aspectRatio(1f).clip(RoundedCornerShape(radius)).background(color(p.primary).copy(alpha = 0.07f)), contentAlignment = Alignment.Center) {
                                                    MerchantImage(category.thumbnail?.let { model.shopping.client.imageURL(it) }, Modifier.fillMaxSize()) {
                                                        Icon(StoreIcons.Categories, contentDescription = null, tint = color(p.primary).copy(alpha = 0.45f), modifier = Modifier.size(32.dp))
                                                    }
                                                }
                                                Text(category.title(settingsState.locale), style = MaterialTheme.typography.labelLarge, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                                            }
                                        }
                                        repeat(3 - row.size) { Spacer(Modifier.weight(1f)) }
                                    }
                                }
                            }
                        }
                        else ->
                            item {
                              if(model.production) Column(verticalArrangement=Arrangement.spacedBy(16.dp)) {
                                CommerceView(model.shopping,settingsState.locale,navigationState.tab,config.features.wishlist,openProduct={model.product(it)},openWishlist={model.selectedTab="wishlist"},shop={model.selectedTab="categories"},toggleLanguage={model.toggleLanguage()},openHelp={model.assistantPresented=true})
                                if(navigationState.tab=="account") StorefrontSettings(model)
                              } else Column(
                                    Modifier.padding(vertical = 40.dp),
                                    verticalArrangement = Arrangement.spacedBy(20.dp),
                                ) {
                                    Text(
                                        label(navigationState.tab),
                                        style = MaterialTheme.typography.headlineMedium,
                                    )
                                    Text(
                                        localized(
                                            "Shopping and account features are coming in the next commerce milestone.",
                                            "ميزات التسوق والحساب قادمة في المرحلة التالية.",
                                        ),
                                    )
                                }
                            }
                    }
                }
            }

            }
        }
    }
}

