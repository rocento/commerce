package com.rocento.mobile

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

@Composable fun AssistantProductPromptView(prompt:JsonObject,shopping:ShoppingModel,locale:String,locked:Boolean,openProduct:(String)->Unit,send:(String,String?)->Unit) {
    val shoppingState = shoppingUiState(shopping)
    fun t(en:String,ar:String)=if(locale=="ar")ar else en
    val query=prompt.text("query").orEmpty();val action=prompt.text("action") ?: "choose"
    val store=remember(query){ProductPromptStore()}
    val state by store.state.collectAsStateWithLifecycle()
    val products=state.products; val selected=state.selected; val loading=state.loading; val failed=state.failed
    val scope=rememberCoroutineScope()
    suspend fun load() = store.load { shopping.client.assistantProducts(query.take(120),locale) }
    DisposableEffect(store){onDispose { store.reset() }}
    fun choose(product:Product,destination:String){val quantity=if(destination=="wishlist")1 else (prompt.text("quantity")?.toIntOrNull() ?: 1).coerceIn(1,1000000);send("Add $quantity of this product to $destination",product.id)}
    LaunchedEffect(query,locale,shoppingState.selectedLocation){load()}
    Column(verticalArrangement=Arrangement.spacedBy(12.dp)) {
        Text(t("Choose a product: ","اختر منتجاً: ")+query,style=MaterialTheme.typography.titleMedium)
        if(loading)LinearProgressIndicator(Modifier.fillMaxWidth())
        if(failed)TextButton(onClick={scope.launch{load()}}){Text(t("Retry product search","إعادة البحث عن المنتجات"))}
        if(!loading && !failed && products.isEmpty())Text(t("No matching products. Try another name.","لا توجد منتجات مطابقة. جرّب اسماً آخر."))
        products.forEach{product->Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(12.dp),verticalArrangement=Arrangement.spacedBy(8.dp)) {
                Row(horizontalArrangement=Arrangement.spacedBy(12.dp)) {
                    MerchantImage(product.thumbnail?.let{shopping.client.imageURL(it)},Modifier.size(64.dp))
                    Column {Text(product.title(locale),style=MaterialTheme.typography.titleMedium);Text("${product.displayPrice} ${product.currency}")}
                }
                if(action=="compare")Row{Checkbox(selected.contains(product.id),{store.select(product.id,it)},enabled=!locked);Text(t("Compare this product","مقارنة هذا المنتج"))}
                else {
                    TextButton(onClick={openProduct(product.id)}){Text(t("View product","عرض المنتج"))}
                    if(product.productType=="simple") {
                        if(action in listOf("cart","choose"))TextButton(onClick={choose(product,"cart")},enabled=!locked && product.inStock){Text(t("Add to bag","إضافة للسلة"))}
                        if(action in listOf("wishlist","choose"))TextButton(onClick={choose(product,"wishlist")},enabled=!locked){Text(t("Save to wishlist","حفظ في المفضلة"))}
                        if(action=="remove")TextButton(onClick={send("Remove this product from cart",product.id)},enabled=!locked){Text(t("Remove from bag","حذف من السلة"))}
                    }
                }
            }
        }}
        if(action=="compare")Button(shape = LocalStorefrontButtonShape.current, onClick={send("Compare "+products.filter{it.id in selected}.joinToString(" and "){"/products/${it.id}"},null)},enabled=!locked && selected.size in 2..5){Text(t("Compare selected products","مقارنة المنتجات المحددة"))}
    }
}
