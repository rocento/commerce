package com.rocento.mobile

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.serialization.json.*

@Composable fun ReorderView(order:CustomerOrder,shopping:ShoppingModel,locale:String) {
    val shoppingState = shoppingUiState(shopping)
    val store=shopping.session.reorder; val state by store.state.collectAsStateWithLifecycle()
    var location by remember(order.id) { mutableStateOf("") }; var replace by remember(order.id) { mutableStateOf(false) }
    var alternative by remember(order.id) { mutableStateOf("") }; var query by remember(order.id) { mutableStateOf("") }
    var products by remember(order.id) { mutableStateOf(emptyList<Product>()) }
    fun t(en:String,ar:String)=if(locale=="ar")ar else en
    val locked=shoppingState.busy || shoppingState.uncertainCheckout || state.busy
    fun revise(selections:List<JsonElement>) { shopping.act { store.revise(JsonArray(selections)) } }
    Column(verticalArrangement=Arrangement.spacedBy(12.dp)) {
        if(state.order?.id!=order.id || state.task==null) {
            Button(onClick={shopping.act { store.start(order) }},enabled=!locked,modifier=Modifier.testTag("reorder-start")){Text(t("Reorder","إعادة الطلب"))}
        } else {
            Text(t("Reorder","إعادة الطلب")+" #${order.number}",style=MaterialTheme.typography.titleLarge)
            val p=state.proposal
            if(state.done) {
                Text(t("Your reorder cart is ready","سلة إعادة الطلب جاهزة"))
                Button(onClick={shopping.act {
                    shopping.session.delivery.refresh(shopping.client)
                    (p?.get("draft") as? JsonObject).text("location_id")?.let { shopping.session.delivery.choose(it,shopping.client) }
                    shopping.session.navigation.selectTab("cart"); shopping.session.navigation.presentCheckout(true)
                }},enabled=!locked){Text(t("Continue to checkout","متابعة لإتمام الشراء"))}
                TextButton(onClick={shopping.act { store.start(order,true) }},enabled=!locked){Text(t("Start another reorder","بدء إعادة طلب أخرى"))}
            } else if(p==null) {
                Text(t("Current basket","السلة الحالية"))
                state.cart?.items?.forEach { Text("${it.quantity} × ${it.name} · ${it.line_total} ${state.cart?.currency}") }
                if(state.cart?.items?.isNotEmpty()==true)Row { Text(t("Empty the current cart before rebuilding this order","إفراغ السلة الحالية قبل إعادة هذا الطلب"),Modifier.weight(1f)); Switch(replace,{replace=it},enabled=!locked) }
                Text(t("Confirm delivery address","تأكيد عنوان التوصيل"))
                state.locations.forEach { address -> FilterChip(selected=location==address.id,onClick={location=address.id},enabled=!locked,label={Text(address.formatted_address)}) }
                if(state.locations.isEmpty())Text(t("Add a saved address in your account, then reload.","أضف عنواناً محفوظاً في الحساب ثم أعد التحميل."))
                Button(onClick={shopping.act { store.prepare(location,replace) }},enabled=!locked && state.locations.any { it.id==location },modifier=Modifier.testTag("reorder-review")){Text(if(replace)t("Empty cart & review reorder","إفراغ السلة ومراجعة إعادة الطلب")else t("Keep cart & review reorder","الاحتفاظ بالسلة ومراجعة إعادة الطلب"))}
            } else {
                val selections=((p["draft"] as? JsonObject)?.get("selections") as? JsonArray).orEmpty()
                Text(t("Review proposed basket","مراجعة السلة المقترحة"),style=MaterialTheme.typography.titleMedium)
                p.items("lines").forEach { line ->
                    val selection=line["selection"] as? JsonObject; val id=selection.text("product_id"); val quantity=(selection?.get("quantity") as? JsonPrimitive)?.intOrNull ?: 1
                    Text((line["product"] as? JsonObject).text("name") ?: t("Unavailable product","منتج غير متوفر"))
                    line.text("historical_price")?.let { Text(t("Previous unit price: ","سعر الوحدة السابق: ")+it) }
                    Row {
                        TextButton(onClick={revise(selections.map { if((it as? JsonObject).text("product_id")==id)JsonObject(it.jsonObject+("quantity" to JsonPrimitive(quantity-1))) else it })},enabled=!locked && !state.pending && quantity>1,modifier=Modifier.semantics { contentDescription=t("Decrease quantity","تقليل الكمية") }){Text("−")}
                        Text(quantity.toString(),Modifier.padding(12.dp))
                        TextButton(onClick={revise(selections.map { if((it as? JsonObject).text("product_id")==id)JsonObject(it.jsonObject+("quantity" to JsonPrimitive(quantity+1))) else it })},enabled=!locked && !state.pending && quantity<1000000,modifier=Modifier.semantics { contentDescription=t("Increase quantity","زيادة الكمية") }){Text("+")}
                        TextButton(onClick={revise(selections.filter { (it as? JsonObject).text("product_id")!=id })},enabled=!locked && !state.pending && selections.size>1){Text(t("Remove","إزالة"))}
                    }
                    TextButton(onClick={alternative=id.orEmpty();query="";products=emptyList()},enabled=!locked && !state.pending){Text(t("Choose replacement","اختيار بديل"))}
                }
                if(alternative.isNotEmpty()) {
                    OutlinedTextField(query,{query=it},label={Text(t("Search replacement","البحث عن بديل"))},enabled=!locked,modifier=Modifier.fillMaxWidth())
                    TextButton(onClick={shopping.act { products=shopping.client.assistantProducts(query,locale).filter { it.inStock && it.productType!="configurable" } }},enabled=!locked && query.isNotBlank()){Text(t("Search","بحث"))}
                    products.filter { product -> selections.none { (it as? JsonObject).text("product_id")==product.id } }.forEach { product ->
                        TextButton(onClick={revise(selections.filter { (it as? JsonObject).text("product_id")!=alternative }+buildJsonObject { put("product_id",product.id);put("quantity",1);put("replaces",JsonNull);put("required_attributes",JsonObject(emptyMap()));put("reason","Customer selected replacement") });alternative=""},enabled=!locked && !state.pending){Text("${product.name} · ${product.price} ${product.currency}")}
                    }
                }
                Text(t("Basket after approval","السلة بعد الموافقة"))
                p.items("resulting_items").forEach { Text("${it.text("quantity")} × ${it.text("name")} · ${it.text("line_total")} ${it.text("currency")}") }
                val after=p["after"] as? JsonObject
                Text(t("Quoted total: ","الإجمالي المعروض: ")+(after.text("payable") ?: t("Not yet verified","لم يتم التحقق بعد"))+" "+after.text("currency").orEmpty())
                ((p["issues"] as? JsonArray).orEmpty()+(p["notes"] as? JsonArray).orEmpty()).forEach { Text(it.jsonPrimitive.content) }
                Text(t("Approval updates your cart. Confirm the order separately at checkout.","الموافقة تعدّل السلة. أكّد الطلب بشكل منفصل عند إتمام الشراء."))
                Button(onClick={shopping.act { store.approve() }},enabled=!locked && (state.pending || p.flag("can_apply")),modifier=Modifier.testTag("reorder-approve")){Text(if(state.pending)t("Check & retry basket update","التحقق وإعادة محاولة تحديث السلة")else t("Approve & apply to bag","الموافقة والتطبيق على السلة"))}
                TextButton(onClick={revise(selections)},enabled=!locked){Text(t("Refresh quote","تحديث العرض"))}
            }
            TextButton(onClick={shopping.act { store.start(order) }},enabled=!locked){Text(t("Reload reorder","إعادة تحميل إعادة الطلب"))}
        }
    }
}
