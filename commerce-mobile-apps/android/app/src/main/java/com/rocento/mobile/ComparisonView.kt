package com.rocento.mobile

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ArrowForward
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch

@Composable fun ComparisonControls(shopping:ShoppingModel,product:String?=null,locale:String,openProduct:(String)->Unit,openAssistant:()->Unit) {
    val shoppingState = shoppingUiState(shopping)
    val store=shopping.session.comparison;val state by store.state.collectAsStateWithLifecycle()
    var presented by remember { mutableStateOf(false) }
    fun t(en:String,ar:String)=if(locale=="ar")ar else en
    val locked=shoppingState.busy || shoppingState.uncertainCheckout
    Column(verticalArrangement=Arrangement.spacedBy(12.dp)) {
        if(product!=null) Row {
            IconButton(onClick={store.toggle(product)},enabled=!locked && (product in state.ids || state.ids.size<5)) {
                Icon(if(product in state.ids) Icons.Default.Check else Icons.Default.List,t("Compare this product","مقارنة هذا المنتج"))
            }
            if(state.ids.isNotEmpty()) IconButton(onClick={presented=true},enabled=!locked) { Icon(Icons.Default.ArrowForward,t("Compare products","مقارنة المنتجات")+" (${state.ids.size}/5)") }
        } else TextButton(onClick={presented=true},enabled=!locked){Text(t("Compare products","مقارنة المنتجات")+" (${state.ids.size}/5)")}

    }
    if(presented)Dialog(onDismissRequest={presented=false},properties=DialogProperties(usePlatformDefaultWidth=false)) {
        Surface(Modifier.fillMaxSize()) {
            Column(Modifier.safeDrawingPadding().padding(20.dp)) {
                TextButton(onClick={presented=false}){Text(t("Done","تم"))}
                Column(Modifier.verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(16.dp)) {
                    Text(t("Compare products","مقارنة المنتجات"),style=MaterialTheme.typography.titleLarge)
                    ComparisonContent(shopping,locale,{presented=false;openProduct(it)},{shopping.assistant.draft=store.prompt;presented=false;openAssistant()})
                }
            }
        }
    }
}
@Composable private fun ComparisonContent(shopping:ShoppingModel,locale:String,open:(String)->Unit,assistant:()->Unit) {
    val shoppingState = shoppingUiState(shopping)
    val store=shopping.session.comparison;val state by store.state.collectAsStateWithLifecycle();val delivery by shopping.session.delivery.state.collectAsStateWithLifecycle()
    val key=listOf(state.ids,locale,shoppingState.customer?.id,delivery.selectedLocation,delivery.guestPin,delivery.locations).toString()
    var ready by remember { mutableStateOf("") };val scope=rememberCoroutineScope()
    suspend fun load(){val expected=key;store.load { shopping.client.product(it,locale) };ready=expected}
    LaunchedEffect(key){load()}
    fun t(en:String,ar:String)=if(locale=="ar")ar else en
    val locked=shoppingState.busy || shoppingState.uncertainCheckout
    state.ids.forEachIndexed { index,id -> TextButton(onClick={store.toggle(id)},enabled=!locked){Text(t("Remove ","إزالة ")+(state.products.firstOrNull{it.id==id}?.name ?: "${index+1}"))} }
    if(state.ids.isNotEmpty())TextButton(onClick={store.reset()},enabled=!locked){Text(t("Clear all","مسح الكل"))}
    if(state.ids.size<2)Text(t("Select at least two products to compare","اختر منتجين على الأقل للمقارنة"))
    if(state.busy)LinearProgressIndicator(Modifier.fillMaxWidth())
    if(state.failed.isNotEmpty()) {
        Text(t("A selected product is unavailable. Remove it or retry.","أحد المنتجات غير متوفر. احذفه أو أعد المحاولة."))
        TextButton(onClick={scope.launch{load()}},enabled=!locked && !state.busy){Text(t("Retry","إعادة المحاولة"))}
    }
    if(ready==key && !state.busy && state.failed.isEmpty() && state.products.size>=2) {
        Column(Modifier.horizontalScroll(rememberScrollState())) {
            Row {
                Text(t("Detail","التفاصيل"),Modifier.width(180.dp).padding(12.dp))
                state.products.forEach { p -> Column(Modifier.width(180.dp).padding(12.dp)) {
                    MerchantImage(p.thumbnail?.let{shopping.client.imageURL(it)},Modifier.size(100.dp))
                    TextButton(onClick={open(p.id)},enabled=!locked){Text(p.title(locale))}
                } }
            }
            store.rows(locale).forEach { row ->
                Row {Text(row.label,Modifier.width(180.dp).padding(12.dp));row.values.forEach{Text(it,Modifier.width(180.dp).padding(12.dp))}}
                HorizontalDivider()
            }
        }
        Text(t("Currencies are not converted. Availability depends on delivery location.","لا يتم تحويل العملات. يعتمد التوفر على موقع التوصيل."),style=MaterialTheme.typography.bodySmall)
        Button(onClick=assistant,enabled=!locked){Text(t("Ask the shopping assistant","اسأل مساعد التسوق"))}
    }
}
