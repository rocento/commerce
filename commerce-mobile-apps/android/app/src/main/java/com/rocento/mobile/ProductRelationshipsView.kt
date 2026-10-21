package com.rocento.mobile

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.CancellationException

@Composable fun ProductRelationshipsView(shopping:ShoppingModel,sources:List<String>,kind:String,locale:String,open:(String)->Unit) {
    val shoppingState = shoppingUiState(shopping)
    val delivery by shopping.session.delivery.state.collectAsStateWithLifecycle()
    val key=listOf(kind,locale,shoppingState.customer?.id,delivery.selectedLocation,delivery.guestPin,delivery.locations,sources.sorted()).toString()
    var products by remember(key) { mutableStateOf(emptyList<Product>()) }
    var failed by remember(key) { mutableStateOf(false) }
    var retry by remember(key) { mutableIntStateOf(0) }
    LaunchedEffect(key,retry) {
        if(sources.isEmpty() || sources.size>50)return@LaunchedEffect
        try { products=shopping.client.relationships(sources,kind,locale);failed=false }
        catch(e:CancellationException){throw e}
        catch(_:Exception){products=emptyList();failed=true}
    }
    if(failed || products.isNotEmpty())Column(verticalArrangement=Arrangement.spacedBy(12.dp)) {
        val title=if(locale=="ar")mapOf("related" to "منتجات ذات صلة","upsell" to "خيارات أخرى قد تعجبك","cross_sell" to "أكمل طلبك")[kind] else mapOf("related" to "Related products","upsell" to "More options to consider","cross_sell" to "Complete your order")[kind]
        Text(title.orEmpty(),style=MaterialTheme.typography.titleMedium)
        if(failed)TextButton(onClick={retry++},enabled=!shoppingState.busy){Text(if(locale=="ar")"إعادة المحاولة" else "Retry")}
        products.forEach { product ->
            OutlinedButton(onClick={open(product.id)},enabled=!shoppingState.busy && !shoppingState.uncertainCheckout,modifier=Modifier.fillMaxWidth()) {
                Column(Modifier.fillMaxWidth()) {
                    Text(product.title(locale));Text("${product.price} ${product.currency}")
                    if(!product.inStock)Text(if(locale=="ar")"غير متوفر" else "Out of stock")
                }
            }
        }
    }
}
