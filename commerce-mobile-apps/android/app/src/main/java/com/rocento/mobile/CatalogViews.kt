package com.rocento.mobile

import androidx.core.content.edit

import android.content.Context
import androidx.compose.foundation.*
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowForward
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.*
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.rocento.mobile.contract.*
import kotlinx.coroutines.ensureActive

internal fun LazyListScope.productRows(
    products: List<Product>, model: StorefrontModel, p: Palette, radius: Dp, columns: Int, prefix: String,
) {
    val count = columns.coerceAtLeast(1)
    items(products.chunked(count), key = { "$prefix:${it.first().id}" }, contentType = { "product-row" }) { row ->
        Row(horizontalArrangement = Arrangement.spacedBy(20.dp)) {
            row.forEach { product -> key(product.id) { ProductCard(product, model, p, radius, Modifier.weight(1f)) } }
            repeat(count - row.size) { Box(Modifier.weight(1f)) }
        }
    }
}

@Composable
internal fun ProductCard(
    product: Product,
    model: StorefrontModel,
    p: Palette,
    radius: Dp,
    modifier: Modifier,
) {
    val settingsState by model.settings.state.collectAsStateWithLifecycle()
    fun localized(en: String, ar: String) = if (settingsState.locale == "ar") ar else en
    Column(
        modifier
            .clickable { model.product(product.id) }
            .testTag("product-${product.id}")
            .semantics(mergeDescendants = true) {},
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if(model.production) MerchantImage(product.thumbnail?.let{model.shopping.client.imageURL(it)},Modifier.fillMaxWidth().height(150.dp).clip(RoundedCornerShape(radius))) else Text(
            symbol(product),
            fontSize = 60.sp,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            modifier =
                Modifier.fillMaxWidth()
                    .padding(vertical = 28.dp)
                    .clearAndSetSemantics {},
        )
        Text(
            product.title(settingsState.locale),
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
        )
        Text(nativePrice(product,model), style = MaterialTheme.typography.titleSmall)
        IconButton(onClick = { model.selectedProduct = null; model.quickPurchase = true; model.product(product.id) }, modifier = Modifier.testTag("quick-add-${product.id}")) {
            Icon(Icons.Outlined.ShoppingCart, localized("Add to cart: ", "إضافة إلى السلة: ") + product.title(settingsState.locale))
        }
        if (product.displayPrice != product.price) {
            Text(nativePrice(product,model,product.price),style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant,textDecoration=androidx.compose.ui.text.style.TextDecoration.LineThrough)
            val savings = product.price.toBigDecimal().subtract(product.displayPrice.toBigDecimal()).toPlainString()
            Text(localized("Save ","وفّر ")+nativePrice(product,model,savings),style=MaterialTheme.typography.labelMedium,color=MaterialTheme.colorScheme.primary)
        }
    }
}

internal fun decodeBrandAsset(bytes:ByteArray):android.graphics.Bitmap? {
    val options=android.graphics.BitmapFactory.Options().apply{inJustDecodeBounds=true}
    android.graphics.BitmapFactory.decodeByteArray(bytes,0,bytes.size,options)
    if(options.outWidth !in 1..4096 || options.outHeight !in 1..4096)return null
    options.inJustDecodeBounds=false
    options.inSampleSize=1
    while(options.outWidth/options.inSampleSize>1024 || options.outHeight/options.inSampleSize>1024)options.inSampleSize*=2
    return android.graphics.BitmapFactory.decodeByteArray(bytes,0,bytes.size,options)
}

@Composable
@OptIn(ExperimentalMaterial3Api::class)
internal fun CategoryFiltersView(model: StorefrontModel) {
    val settingsState by model.settings.state.collectAsStateWithLifecycle()
    val catalogState by model.catalogStore.state.collectAsStateWithLifecycle()
    fun localized(en: String, ar: String) = if (settingsState.locale == "ar") ar else en
    var expanded by remember(catalogState.selectedCategory) { mutableStateOf(false) }
    var f by remember(catalogState.selectedCategory) { mutableStateOf(catalogState.categoryFilters) }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(catalogState.categories.firstOrNull { it.id == catalogState.selectedCategory || it.slug == catalogState.selectedCategory }?.title(settingsState.locale) ?: localized("Category", "الفئة"), style = MaterialTheme.typography.headlineSmall)
        OutlinedButton(shape=LocalStorefrontButtonShape.current,onClick = { f = catalogState.categoryFilters; expanded = true }) { Text(localized("Filter & sort", "تصفية وترتيب")) }
        val parent = catalogState.categories.firstOrNull { it.id == catalogState.selectedCategory || it.slug == catalogState.selectedCategory }
        val children = catalogState.categories.filter { parent != null && it.parent_id == parent.id }
        if (children.isNotEmpty()) LazyRow(modifier=Modifier.testTag("subcategory-slider"),horizontalArrangement=Arrangement.spacedBy(8.dp)) { items(children) { category ->
            FilterChip(selected=catalogState.selectedCategory==category.id,onClick={model.category(category.id)},label={Text(category.title(settingsState.locale))})
        } }
        if (expanded) {
          ModalBottomSheet(onDismissRequest={expanded=false},sheetState=rememberModalBottomSheetState(skipPartiallyExpanded=true),containerColor=Color.White) {
            Column(Modifier.fillMaxHeight(0.9f)) {
            Text(localized("Filter & sort","تصفية وترتيب"),style=MaterialTheme.typography.titleLarge,modifier=Modifier.padding(horizontal=20.dp))
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(20.dp),verticalArrangement=Arrangement.spacedBy(16.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text(localized("Refine your results", "حدد النتائج المناسبة"), style = MaterialTheme.typography.bodySmall)
                TextButton(onClick = { f = CatalogFilters() }) { Text(localized("Reset", "إعادة تعيين")) }
            }
            OutlinedTextField(value = f.query, onValueChange = { f = f.copy(query = it) }, label = { Text(localized("Search products", "البحث عن المنتجات")) }, modifier = Modifier.fillMaxWidth().testTag("category-query"))
            var sortOpen by remember { mutableStateOf(false) }
            Box {
                TextButton(onClick = { sortOpen = true }) { Text(localized("Sort by", "ترتيب حسب") + ": " + when(f.sort) {
                    "price_asc" -> localized("Price: low to high", "السعر: الأقل أولاً")
                    "price_desc" -> localized("Price: high to low", "السعر: الأعلى أولاً")
                    "name_asc" -> localized("Name: A–Z", "الاسم")
                    "name_desc" -> localized("Name: Z–A", "الاسم: تنازلياً")
                    else -> if(":" in f.sort) (catalogState.categoryAttributes.firstOrNull { it.attribute_code == f.sort.substringBefore(":") }?.label ?: "") + if(f.sort.endsWith("desc")) localized(": descending", ": تنازلياً") else localized(": ascending", ": تصاعدياً") else localized("Relevance", "الأكثر صلة")
                }) }
                DropdownMenu(expanded = sortOpen, onDismissRequest = { sortOpen = false }) {
                    (listOf("relevance" to localized("Relevance", "الأكثر صلة"), "price_asc" to localized("Price: low to high", "السعر: الأقل أولاً"), "price_desc" to localized("Price: high to low", "السعر: الأعلى أولاً"), "name_asc" to localized("Name: A–Z", "الاسم"), "name_desc" to localized("Name: Z–A", "الاسم: تنازلياً")) + catalogState.categoryAttributes.filter { it.metadata?.sortable == true && it.attribute_code !in listOf("name", "price") }.flatMap { listOf((it.attribute_code + ":asc") to (it.label + localized(": ascending", ": تصاعدياً")), (it.attribute_code + ":desc") to (it.label + localized(": descending", ": تنازلياً"))) }).forEach { (value, label) ->
                        DropdownMenuItem(text = { Text(label) }, onClick = { f = f.copy(sort = value); sortOpen = false })
                    }
                }
            }
            val priceLimit = maxOf(10_000f, f.minimum.toFloatOrNull() ?: 0f, f.maximum.toFloatOrNull() ?: 0f)
            Text(localized("Min price", "أقل سعر") + ": " + f.minimum.ifEmpty { "0" })
            Slider(value = f.minimum.toFloatOrNull() ?: 0f, onValueChange = { value ->
                val price = minOf(value.toInt(), (f.maximum.toFloatOrNull() ?: priceLimit).toInt())
                f = f.copy(minimum = if (price == 0) "" else price.toString())
            }, valueRange = 0f..priceLimit, modifier = Modifier.testTag("category-min").semantics { contentDescription = localized("Min price", "أقل سعر") })
            Text(localized("Max price", "أعلى سعر") + ": " + f.maximum.ifEmpty { localized("Any price", "أي سعر") })
            Slider(value = f.maximum.toFloatOrNull() ?: priceLimit, onValueChange = { value ->
                val price = maxOf(value.toInt(), (f.minimum.toFloatOrNull() ?: 0f).toInt())
                f = f.copy(maximum = if (price >= priceLimit) "" else price.toString())
            }, valueRange = 0f..priceLimit, modifier = Modifier.testTag("category-max").semantics { contentDescription = localized("Max price", "أعلى سعر") })
            Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                Checkbox(checked = f.inStock, onCheckedChange = { f = f.copy(inStock = it) })
                Text(localized("In stock only", "المتوفر فقط"))
            }
            catalogState.categoryAttributes.filter { it.showsFilter(catalogState.categoryFacets[it.attribute_code] ?: emptyMap(), f.attributes[it.attribute_code] ?: emptyList()) }.forEach { attribute ->
                val selected = f.attributes[attribute.attribute_code] ?: emptyList()
                val choices = attribute.choices(catalogState.categoryFacets[attribute.attribute_code] ?: emptyMap(), selected)
                var attributeExpanded by remember(catalogState.selectedCategory, attribute.attribute_code) { mutableStateOf(false) }
                TextButton(onClick = { attributeExpanded = !attributeExpanded }, modifier = Modifier.fillMaxWidth().testTag("category-attribute-${attribute.attribute_code}")) {
                    Text(attribute.label, modifier = Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
                    Icon(if (attributeExpanded) Icons.Outlined.KeyboardArrowUp else Icons.Outlined.KeyboardArrowDown, contentDescription = localized(if (attributeExpanded) "Collapse" else "Expand", if (attributeExpanded) "طي" else "توسيع"))
                }
                fun update(values: List<String>) {
                    f = f.copy(attributes = if(values.isEmpty()) f.attributes - attribute.attribute_code else f.attributes + (attribute.attribute_code to values), attributeTypes = f.attributeTypes + (attribute.attribute_code to attribute.input_type))
                }
                if (attributeExpanded) {
                if(attribute.usesChoices) choices.forEach { value ->
                    Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                        Checkbox(checked = value in selected, onCheckedChange = { update(if(it) selected + value else selected - value) })
                        Text(attribute.options.firstOrNull { it.value == value }?.label ?: if(attribute.input_type == "boolean") { if(value == "true") localized("Yes", "نعم") else localized("No", "لا") } else value)
                    }
                } else OutlinedTextField(value = selected.firstOrNull() ?: "", onValueChange = { update(if(it.isEmpty()) emptyList() else listOf(it)) }, label = { Text(attribute.label) }, modifier = Modifier.fillMaxWidth())
                }
            }
            if (!f.valid) Text(localized("Enter a valid price range.", "أدخل نطاق أسعار صالحاً."), color = MaterialTheme.colorScheme.error)
            }
            Button(shape=LocalStorefrontButtonShape.current,onClick={model.categoryFilters=f; model.browseCategory(); expanded=false},enabled=f.valid,modifier=Modifier.fillMaxWidth().padding(16.dp).heightIn(min=52.dp)) { Text(localized("Show results","عرض النتائج")) }
            }
          }
        }
        if (catalogState.categoryLoading) CircularProgressIndicator()
        catalogState.categoryError?.let {
            Text(it)
            TextButton(onClick = { model.browseCategory(catalogState.categoryProducts.isNotEmpty()) }) { Text(localized("Retry", "إعادة المحاولة")) }
        }
        Text("${catalogState.categoryTotal} " + localized("products", "منتج"))
        if (!catalogState.categoryLoading && catalogState.categoryError == null && catalogState.categoryProducts.isEmpty()) Text(localized("No products match. Try resetting the filters.", "لا توجد منتجات مطابقة. جرّب إعادة تعيين الفلاتر."))
    }
}

@Composable internal fun EditorialCopy(model:StorefrontModel,p:Palette,heading:String?,body:String?,eyebrow:String?,label:String?,action:Action?,path:String?,campaign:Boolean,textKey:String?=null) {
    val settingsState by model.settings.state.collectAsStateWithLifecycle()
    val uri=androidx.compose.ui.platform.LocalUriHandler.current
    Column(Modifier.fillMaxWidth().padding(horizontal=if(campaign) 18.dp else 12.dp,vertical=if(campaign) 26.dp else 24.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
        eyebrow?.let { Text(model.config.text(it,settingsState.locale),fontSize=10.sp,letterSpacing=1.6.sp) }
        heading?.let { Text(model.config.text(it,settingsState.locale),fontSize=27.sp,lineHeight=31.sp,fontWeight=FontWeight.Medium,letterSpacing=(-0.5).sp,modifier=Modifier.semantics { heading() }) }
        body?.let { Text(model.config.text(it,settingsState.locale),fontSize=14.sp,lineHeight=22.sp) }
        textKey?.let { Text(model.config.text(it,settingsState.locale),fontSize=if(heading==null) 27.sp else 14.sp,lineHeight=if(heading==null) 31.sp else 22.sp,fontWeight=if(heading==null) FontWeight.Medium else FontWeight.Normal) }
        if(action!=null || path!=null) label?.let { TextButton(onClick={if(path=="/assistant" && model.production) model.assistantPresented=true else if(path!=null) uri.openUri(java.net.URI(model.identity.commerceBase).resolve(path).toString()) else action?.let(model::open)}) { Text(model.config.text(it,settingsState.locale)+" ↗",fontSize=13.sp,color=color(p.primary),textDecoration=androidx.compose.ui.text.style.TextDecoration.Underline) } }
    }
}
internal fun nativePrice(product:Product,model:StorefrontModel,amount:String=product.displayPrice):String {
    return runCatching { java.text.NumberFormat.getCurrencyInstance(if(model.locale=="ar") java.util.Locale.forLanguageTag("ar-EG") else java.util.Locale.US).apply { currency=java.util.Currency.getInstance(product.currency) }.format(amount.toBigDecimal()) }.getOrDefault("$amount ${product.currency}")
}

@Composable
internal fun StoreHeader(model: StorefrontModel) {
    val shoppingState = shoppingUiState(model.shopping)
    val catalogState by model.catalogStore.state.collectAsStateWithLifecycle()
    val navigationState by model.shopping.session.navigation.state.collectAsStateWithLifecycle()
    val settingsState by model.settings.state.collectAsStateWithLifecycle()
    fun localized(en: String, ar: String) = if (settingsState.locale == "ar") ar else en
    var query by rememberSaveable { mutableStateOf("") }
    var locationsOpen by remember { mutableStateOf(false) }
    val keyboard = LocalSoftwareKeyboardController.current
    fun submitSearch() { keyboard?.hide(); model.search(query) }
    Surface(color = Color.White) {
        Column(Modifier.statusBarsPadding().padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Box(Modifier.weight(1f)) {
                    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable { locationsOpen = true }.testTag("header-location"), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Icon(Icons.Outlined.LocationOn, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.primary)
                        Column(Modifier.weight(1f)) {
                            Text(localized("Deliver to", "التوصيل إلى"), style = MaterialTheme.typography.labelSmall)
                            shoppingState.locations.firstOrNull { it.id == shoppingState.selectedLocation }?.formatted_address.orEmpty().ifEmpty { shoppingState.guestAddress.orEmpty() }.takeIf { it.isNotEmpty() }?.let { address ->
                                Text(address, style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
                            }
                        }
                    }
                    if (locationsOpen) AddressDialog(model.shopping, settingsState.locale) { locationsOpen = false }
                }
                IconButton(onClick = { model.selectedTab = "account"; model.shopping.session.navigation.open("notifications") }, modifier = Modifier.testTag("open-notifications")) {
                    Icon(Icons.Outlined.Notifications, localized("Notifications", "الإشعارات"), tint = MaterialTheme.colorScheme.primary)
                }
                if (model.production) IconButton(onClick = { model.assistantPresented = true }, modifier = Modifier.testTag("open-assistant")) {
                    Icon(StoreIcons.Assistant, localized("Shopping assistant", "مساعد التسوق"), tint = MaterialTheme.colorScheme.primary)
                }
            }
            OutlinedTextField(value = query, onValueChange = { query = it.take(120) }, placeholder = { Text(localized("Search products", "البحث عن المنتجات")) }, leadingIcon = { Icon(Icons.Outlined.Search, null) }, trailingIcon = { if (query.isNotEmpty()) IconButton(onClick = { submitSearch() }) { Icon(Icons.AutoMirrored.Outlined.ArrowForward, localized("Search", "بحث")) } }, singleLine = true, shape = RoundedCornerShape(16.dp), keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search), keyboardActions = KeyboardActions(onSearch = { submitSearch() }), modifier = Modifier.fillMaxWidth().testTag("header-search"))
            if (navigationState.tab == "categories" && catalogState.selectedCategory != null) TextButton(onClick = model::closeCategory) { Text(localized("Back to categories", "العودة إلى الأقسام")) }
        }
    }
}

@Composable
internal fun DealsView(model: StorefrontModel, palette: Palette, radius: Dp) {
    val settingsState by model.settings.state.collectAsStateWithLifecycle()
    fun localized(en: String, ar: String) = if (settingsState.locale == "ar") ar else en
    var products by remember(settingsState.locale) { mutableStateOf<List<Product>>(emptyList()) }
    var offset by remember(settingsState.locale) { mutableIntStateOf(0) }
    var more by remember(settingsState.locale) { mutableStateOf(true) }
    var loading by remember(settingsState.locale) { mutableStateOf(false) }
    var failed by remember(settingsState.locale) { mutableStateOf(false) }
    var request by remember(settingsState.locale) { mutableIntStateOf(0) }
    LaunchedEffect(settingsState.locale, request) {
        loading = true
        failed = false
        try {
            val targetCount = products.size + 12
            for (scan in 0 until 10) {
                val page = model.catalog.browse("", CatalogFilters(), offset, settingsState.locale)
                kotlinx.coroutines.currentCoroutineContext().ensureActive()
                products = (products + page.hits.filter { it.active != false && it.displayPrice != it.price }).distinctBy { it.id }
                offset += page.hits.size
                more = page.hits.isNotEmpty() && offset < page.total && offset <= 9999
                if (!more || products.size >= targetCount) break
            }
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            failed = true
        } finally { loading = false }
    }
    val columns = if (LocalDensity.current.fontScale > 1.5) 1 else 2
    LazyColumn(contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item {
        Text(localized("Deals", "العروض"), style = MaterialTheme.typography.headlineLarge)
        Text(localized("Current offers, with savings shown upfront.", "عروض حالية مع توضيح قيمة التوفير."))
        Text(localized("Final prices and eligibility are confirmed at checkout.", "يتم تأكيد الأسعار النهائية وشروط الاستحقاق عند إتمام الطلب."),style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
        }
        productRows(products, model, palette, radius, columns, "deals")
        item {
        if (loading) LinearProgressIndicator(Modifier.fillMaxWidth().testTag("deals-loading"))
        if (failed) Text(localized("Unable to load deals. Please retry.", "تعذر تحميل العروض. يرجى المحاولة."),modifier=Modifier.testTag("deals-error"))
        if (!loading && !failed && products.isEmpty()) Text(if (more) localized("No offers in these products. Explore more below.", "لا توجد عروض في هذه المنتجات. استكشف المزيد أدناه.") else localized("No deals available right now", "لا توجد عروض حالياً"),modifier=Modifier.testTag("deals-empty"))
        if (more || failed) TextButton(onClick = { request++ }, enabled = !loading) { Text(if (failed) localized("Retry", "إعادة المحاولة") else localized("Explore more deals", "استكشف المزيد من العروض")) }
        }
    }
}

internal object StoreIcons {
    val Bookmark = outlinedIcon("Bookmark") {
        moveTo(6f,3f);lineTo(18f,3f);lineTo(18f,21f);lineTo(12f,17f);lineTo(6f,21f);close()
    }
    val Bag = outlinedIcon("Bag") {
        moveTo(4f,7f);lineTo(20f,7f);lineTo(20f,21f);lineTo(4f,21f);close()
        moveTo(8f,8f);lineTo(8f,5f);curveTo(8f,0f,16f,0f,16f,5f);lineTo(16f,8f)
    }
    val Minus = outlinedIcon("Minus") { moveTo(5f,12f);lineTo(19f,12f) }
    val Sparkles = outlinedIcon("Sparkles") {
        moveTo(10f,3f);lineTo(12f,10f);lineTo(19f,12f);lineTo(12f,14f);lineTo(10f,21f);lineTo(8f,14f);lineTo(1f,12f);lineTo(8f,10f);close()
        moveTo(19f,2f);lineTo(19f,8f);moveTo(16f,5f);lineTo(22f,5f)
    }
    val Assistant = outlinedIcon("ShoppingAssistant") {
        moveTo(4f, 3f); lineTo(20f, 3f); lineTo(20f, 17f); lineTo(9f, 17f); lineTo(4f, 21f); close()
        moveTo(8f, 8f); lineTo(16f, 8f)
        moveTo(8f, 12f); lineTo(13f, 12f)
    }
    val Categories = outlinedIcon("Categories") {
        moveTo(3f, 3f); lineTo(9f, 3f); lineTo(9f, 9f); lineTo(3f, 9f); close()
        moveTo(15f, 3f); lineTo(21f, 3f); lineTo(21f, 9f); lineTo(15f, 9f); close()
        moveTo(3f, 15f); lineTo(9f, 15f); lineTo(9f, 21f); lineTo(3f, 21f); close()
        moveTo(15f, 15f); lineTo(21f, 15f); lineTo(21f, 21f); lineTo(15f, 21f); close()
    }
    val Deals = outlinedIcon("Deals") {
        moveTo(3f, 3f); lineTo(11f, 3f); lineTo(21f, 13f); lineTo(13f, 21f); lineTo(3f, 11f); close()
        moveTo(7f, 7f); lineTo(7.01f, 7f)
    }
    private fun outlinedIcon(name: String, draw: androidx.compose.ui.graphics.vector.PathBuilder.() -> Unit): androidx.compose.ui.graphics.vector.ImageVector =
        androidx.compose.ui.graphics.vector.ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f).apply {
            path(fill = null, stroke = androidx.compose.ui.graphics.SolidColor(Color.Black), strokeLineWidth = 1.7f, strokeLineCap = androidx.compose.ui.graphics.StrokeCap.Round, strokeLineJoin = androidx.compose.ui.graphics.StrokeJoin.Round, pathBuilder = draw)
        }.build()
}

class StorefrontNotificationPreferences(context: Context): NotificationPreferences {
    private val prefs=context.getSharedPreferences("storefront.preferences",Context.MODE_PRIVATE)
    override var orderUpdates: Boolean
        get()=prefs.getBoolean("orderUpdates",true)
        set(value){prefs.edit { putBoolean("orderUpdates",value) }}
    override fun readIDs(owner: String)=prefs.getStringSet("notificationRead.$owner",emptySet())!!.toSet()
    override fun setReadIDs(ids: Set<String>,owner: String){prefs.edit { putStringSet("notificationRead.$owner",ids) }}
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun QuickPurchaseSheet(model: StorefrontModel) {
    val catalog by model.catalogStore.state.collectAsStateWithLifecycle()
    val shopping = shoppingUiState(model.shopping)
    val settings by model.settings.state.collectAsStateWithLifecycle()
    fun t(en: String, ar: String) = if (settings.locale == "ar") ar else en
    fun close() { model.quickPurchase = false; model.selectedProduct = null }
    val product = catalog.selectedProduct
    var draftQuantity by remember(product?.id) { mutableIntStateOf(1) }
    val quantity = shopping.cart?.items?.firstOrNull { it.product_id == product?.id }?.quantity ?: 0
    val locked = shopping.busy || shopping.uncertainCheckout
    ModalBottomSheet(onDismissRequest = ::close, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().heightIn(max=640.dp).verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement=Arrangement.spacedBy(16.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment=Alignment.CenterVertically) {
                Text(t("Add to cart", "إضافة إلى السلة"), style=MaterialTheme.typography.titleLarge, modifier=Modifier.weight(1f))
                TextButton(onClick=::close) { Text(t("Done", "تم")) }
            }
            if (product == null) {
                if (model.problem != null) Text(model.problem.orEmpty()) else CircularProgressIndicator()
            } else {
                MerchantImage(product.thumbnail?.let { model.shopping.client.imageURL(it) }, Modifier.fillMaxWidth().height(180.dp))
                Text(product.title(settings.locale), style=MaterialTheme.typography.titleLarge)
                Text(nativePrice(product, model))
                shopping.error?.let { Text(it, color=MaterialTheme.colorScheme.error) }
                shopping.notice?.let { Text(it) }
                if (shopping.selectedLocation.isEmpty()) {
                    Button(onClick={close(); model.selectedTab="account"}) { Text(t("Choose delivery address", "اختيار عنوان التوصيل")) }
                } else if (product.productType != "simple") {
                    Text(t("Choose your size or option", "اختر الحجم أو النوع"))
                    model.problem?.let { Text(it, color=MaterialTheme.colorScheme.error) }
                    if (catalog.variants.isEmpty()) Text(t("No options are available.", "لا توجد خيارات متاحة."))
                    catalog.variants.forEach { variant ->
                        OutlinedButton(onClick={model.product(variant.id)}, enabled=!locked) { Text(variant.title(settings.locale) + " · " + nativePrice(variant, model)) }
                    }
                } else {
                    Row(verticalAlignment=Alignment.CenterVertically) {
                        IconButton(onClick={if(quantity==0) draftQuantity=maxOf(1,draftQuantity-1) else model.shopping.quantity(product.id,quantity-1)}, enabled=!locked && (quantity>0 || draftQuantity>1)) { Icon(StoreIcons.Minus,t("Decrease quantity","تقليل الكمية")) }
                        Text("${if(quantity==0) draftQuantity else quantity}",modifier=Modifier.testTag("quick-add-quantity"))
                        IconButton(onClick={if(quantity==0) draftQuantity++ else model.shopping.quantity(product.id,quantity+1)},enabled=!locked && product.inStock && (if(quantity==0) draftQuantity else quantity)<99) { Icon(Icons.Default.Add,t("Increase quantity","زيادة الكمية")) }
                    }
                    if(quantity==0) Button(onClick={if(shopping.customer==null){close();model.selectedTab="account"}else model.shopping.add(product.id,draftQuantity)},enabled=!locked && product.inStock,modifier=Modifier.fillMaxWidth().testTag("quick-add-confirm")) { Text(if(product.inStock)t("Add to cart","إضافة إلى السلة")else t("Out of stock","غير متوفر")) }
                }
            }
        }
    }
}
