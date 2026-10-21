package com.rocento.mobile

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

@Composable fun AssistantProposalView(id:String,shopping:ShoppingModel,locale:String,locked:Boolean,navigate:(String)->Unit) {
    val shoppingState = shoppingUiState(shopping)
    fun t(en:String,ar:String)=if(locale=="ar")ar else en
    val store=remember(id,shoppingState.customer?.id){AssistantProposalStore { shopping.client.assistantProposal(id) }}
    val state by store.state.collectAsStateWithLifecycle()
    val proposal=state.proposal; val working=state.busy; val pending=state.pending
    val problem=when(state.issue) {
        "load"->t("Unable to load this proposal. Sign in and try again.","تعذر تحميل المقترح. سجّل الدخول وحاول مجدداً.")
        "unconfirmed"->t("The outcome is not confirmed. Check again before making more changes.","لم يتم تأكيد النتيجة. تحقق مجدداً قبل إجراء تغييرات أخرى.")
        "apply"->t("Unable to confirm the update. Check its status before approving again.","تعذر تأكيد التحديث. تحقق من حالته قبل الموافقة مجدداً.")
        else->null
    }
    val scope=rememberCoroutineScope()
    suspend fun reload() = store.reload { shopping.refreshAssistantCart() }
    LaunchedEffect(store){reload()}
    DisposableEffect(store){onDispose { store.reset() }}
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
            Text(t("Review proposed basket","مراجعة السلة المقترحة"),style=MaterialTheme.typography.titleMedium)
            proposal?.let{p->
                val draft=p["draft"] as? JsonObject
                val after=p["after"] as? JsonObject
                Text((draft?.get("goal") as? JsonObject).text("purpose").orEmpty())
                Text(t("Current basket","السلة الحالية"),style=MaterialTheme.typography.titleSmall)
                p.items("current_items").forEach{Text("${it.text("quantity")} × ${it.text("name")} · ${it.text("line_total")} ${it.text("currency")}",style=MaterialTheme.typography.bodyMedium)}
                Text(t("Basket after approval","السلة بعد الموافقة"),style=MaterialTheme.typography.titleSmall)
                p.items("resulting_items").forEach{Text("${it.text("quantity")} × ${it.text("name")} · ${it.text("line_total")} ${it.text("currency")}",style=MaterialTheme.typography.bodyMedium)}
                listOf("subtotal" to t("Subtotal","المجموع الفرعي"),"discount" to t("Discount","الخصم"),"tax" to t("Tax","الضريبة"),"delivery" to t("Delivery","التوصيل"),"payable" to t("Total","الإجمالي")).forEach{(key,label)->Text(label+": "+(after.text(key)?.let{"$it ${after.text("currency")}"} ?: t("Not yet verified","لم يتم التحقق بعد")))}
                ((p["issues"] as? JsonArray).orEmpty()+(p["notes"] as? JsonArray).orEmpty()).forEach{Text(it.jsonPrimitive.content,style=MaterialTheme.typography.bodySmall)}
                p.text("expires_at")?.let{Text(t("Valid until: ","صالح حتى: ")+CommercePresentation.dateTime(it,locale),style=MaterialTheme.typography.bodySmall)}
                if(p.flag("applied")) {
                    Text(t("Applied to your bag. Review checkout separately to place your order.","تم التطبيق على سلتك. راجع إتمام الطلب بشكل منفصل لتأكيده."))
                    TextButton(onClick={navigate("cart")}){Text(t("View bag & checkout","عرض السلة وإتمام الطلب"))}
                } else {
                    val canApply=store.canApply
                    Text(t("Approval changes your bag; it does not place an order.","الموافقة تعدّل السلة ولا تؤكد الطلب."),style=MaterialTheme.typography.bodySmall)
                    Button(shape = LocalStorefrontButtonShape.current, enabled=!working && !locked && (pending || canApply),onClick={
                        if(shoppingState.customer==null)navigate("account")
                        else scope.launch {
                            store.apply(locked,operation={location->shopping.applyProposal(id,location)},settled={shopping.refreshAssistantCart()})
                        }
                    }){Text(if(pending)t("Check update status","تحقق من حالة التحديث")else t("Approve & apply to bag","الموافقة والتطبيق على السلة"))}
                }
            }
            if(working)LinearProgressIndicator(Modifier.fillMaxWidth())
            problem?.let{Text(it,color=MaterialTheme.colorScheme.error)}
            TextButton(onClick={scope.launch{reload()}},enabled=!working && !locked){Text(t("Refresh proposal","تحديث المقترح"))}
        }
    }
}
