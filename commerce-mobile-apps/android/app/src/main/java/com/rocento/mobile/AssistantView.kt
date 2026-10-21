package com.rocento.mobile

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.*
import kotlinx.serialization.json.*

class AssistantChatModel(val store: AssistantStore) {
    private fun snapshot(): AssistantState = store.state.value
    val turns get() = snapshot().turns
    var draft: String
        get() = snapshot().draft
        set(value) { store.draft=value }
    val busy get() = snapshot().busy
    val stage get() = snapshot().stage
    val signInRequired get() = snapshot().signInRequired
    fun reset() = store.reset()
    fun stop() = store.stop()
    fun send(message:String,locale:String,productID:String?=null,cartContext:Boolean=false,settled:suspend ()->Unit,checkout:()->Unit) =
        store.send(message,locale,productID,cartContext,settled,checkout)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun AssistantScreen(chat:AssistantChatModel,shopping:ShoppingModel,locale:String,close:()->Unit,navigate:(String)->Unit,openProduct:(String)->Unit) {
    val shoppingState = shoppingUiState(shopping)
    val chatState by chat.store.state.collectAsStateWithLifecycle()
    fun t(en:String,ar:String)=if(locale=="ar")ar else en
    val locked=chatState.busy || shoppingState.busy || shoppingState.uncertainCheckout
    val focus=LocalFocusManager.current
    fun send(message:String,product:String?=null,cart:Boolean=false) {
        if(shoppingState.busy || shoppingState.uncertainCheckout)return
        focus.clearFocus()
        chat.send(message,locale,product,cart,settled={shopping.refreshAssistantCart()},checkout={navigate(if(shopping.customer==null)"account" else "cart")})
    }
    var menu by remember{mutableStateOf(false)}
    val scroll=rememberLazyListState()
    BackHandler {close()}
    DisposableEffect(chat) {onDispose{chat.stop()}}
    LaunchedEffect(shopping,locale){shopping.client.setLocale(locale);shopping.load()}
    LaunchedEffect(chatState.turns.lastOrNull()?.reply?.text,chatState.busy){if(scroll.layoutInfo.totalItemsCount>0)scroll.animateScrollToItem(scroll.layoutInfo.totalItemsCount-1)}
    Scaffold(
        modifier=Modifier.fillMaxSize().imePadding(),
        topBar={TopAppBar(title={Text(t("Shopping assistant","مساعد التسوق"))},navigationIcon={TextButton(onClick=close,modifier=Modifier.testTag("assistant-close")){Text(t("Done","تم"))}},actions={
            IconButton(onClick={menu=true}){Icon(Icons.Default.MoreVert,t("Chat options","خيارات المحادثة"))}
            DropdownMenu(menu,{menu=false}) {
                DropdownMenuItem(text={Text(t("View bag & checkout","عرض السلة وإتمام الطلب"))},onClick={menu=false;navigate("cart")})
                DropdownMenuItem(text={Text(t("Delivery address","عنوان التوصيل"))},onClick={menu=false;navigate("account")})
                DropdownMenuItem(text={Text(t("New conversation","محادثة جديدة"))},onClick={menu=false;chat.reset()},enabled=!chatState.busy)
            }
        })},
        bottomBar={Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface).navigationBarsPadding().padding(16.dp),verticalArrangement=Arrangement.spacedBy(8.dp)) {
            if(shoppingState.uncertainCheckout)Text(t("Resolve your pending checkout before changing your bag.","تحقق من نتيجة طلبك المعلق قبل تعديل السلة."),style=MaterialTheme.typography.bodySmall)
            Row(verticalAlignment=Alignment.Bottom,horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(chatState.draft,{chat.draft=it},placeholder={Text(t("Ask your shopping assistant…","اسأل مساعد التسوق…"))},maxLines=5,modifier=Modifier.weight(1f).testTag("assistant-input"))
                if(chatState.busy) TextButton(onClick=chat::stop,modifier=Modifier.testTag("assistant-stop")){Text(t("Stop","إيقاف"))}
                else Button(shape = LocalStorefrontButtonShape.current, onClick={send(chatState.draft)},enabled=!locked && chatState.draft.isNotBlank() && chatState.draft.codePointCount(0,chatState.draft.length)<=4000,modifier=Modifier.testTag("assistant-send")){Icon(Icons.AutoMirrored.Filled.Send,t("Send message","إرسال الرسالة"))}
            }
            if(chatState.draft.codePointCount(0,chatState.draft.length)>4000)Text(t("Use 4,000 characters or fewer.","استخدم ٤٠٠٠ حرف أو أقل."),color=MaterialTheme.colorScheme.error)
        }}
    ) { padding ->
        LazyColumn(state=scroll,modifier=Modifier.padding(padding).fillMaxSize().testTag("assistant-messages"),contentPadding=PaddingValues(20.dp),verticalArrangement=Arrangement.spacedBy(24.dp)) {
            if(chatState.turns.isEmpty()) item {
                Column(verticalArrangement=Arrangement.spacedBy(14.dp)) {
                    Text(t("Find something you’ll love","اعثر على ما يناسبك"),style=MaterialTheme.typography.headlineSmall)
                    Text(t("Ask for recommendations, compare products, or get help with your bag.","اطلب ترشيحات أو قارن المنتجات أو احصل على مساعدة في سلتك."))
                    listOf(
                        t("Where is my last order?","أين طلبي الأخير؟") to t("Where is my last order?","أين طلبي الأخير؟"),
                        t("Recommended today","ترشيحات اليوم") to t("Recommend a product for today","رشّح لي منتجاً لليوم"),
                    ).forEach { (label,message) ->
                        OutlinedButton(shape = LocalStorefrontButtonShape.current, onClick={send(message)},enabled=!locked){Text(label)}
                    }
                    SupportControls(shopping,locale,label=t("Show my tickets","اعرض تذاكري"),showTickets=true)
                    listOf(
                        t("Find best sellers","الأكثر مبيعاً") to t("Recommend best-selling products","رشّح لي المنتجات الأكثر مبيعاً"),
                        t("Best discounts today","أفضل خصومات اليوم") to t("Recommend products with the best discounts today","رشّح لي المنتجات بأفضل الخصومات اليوم"),
                        t("Best value items","أفضل المنتجات قيمة") to t("Recommend the best value products","رشّح لي أفضل المنتجات قيمة مقابل السعر"),
                    ).forEach { (label,message) ->
                        OutlinedButton(shape = LocalStorefrontButtonShape.current, onClick={send(message)},enabled=!locked){Text(label)}
                    }
                }
            }
            item { AssistantLibraryControls(shopping,chat,locale) }
            items(chatState.turns,key={it.id}) {turn->
                Column(verticalArrangement=Arrangement.spacedBy(16.dp)) {
                    Box(Modifier.fillMaxWidth(),contentAlignment=Alignment.CenterEnd){SelectionContainer {Text(turn.question,Modifier.background(MaterialTheme.colorScheme.primary.copy(alpha=0.12f),RoundedCornerShape(18.dp)).padding(14.dp))}}
                    if(turn.reply.text.isNotEmpty())SelectionContainer{Text(turn.reply.text,modifier=Modifier.testTag("assistant-reply"))}
                    turn.reply.blocks.forEach{block->AssistantBlockView(block,shopping,locale,locked,navigate,openProduct,send={message,product->send(message,product)})}
                    turn.reply.order?.let{order->TextButton(onClick={navigate("account")}){Text(t("View order","عرض الطلب")+" #"+order.text("number").orEmpty())}}
                    if(turn.reply.ticket!=null)Text(t("Your support request has been received.","تم استلام طلب الدعم."))
                    (turn.reply.ticket?.get("ticket") as? kotlinx.serialization.json.JsonObject)?.text("id")?.takeIf{shoppingState.customer!=null && assistantUUID(it)}?.let{id->SupportControls(shopping,locale,ticket=id)}
                    if(turn.reply.needsLogin)TextButton(onClick={navigate("account")}){Text(t("Sign in","تسجيل الدخول"))}
                    if(turn.reply.needsAddress)TextButton(onClick={navigate("account")}){Text(t("Choose delivery address","اختيار عنوان التوصيل"))}
                    if(turn.id==chatState.turns.lastOrNull()?.id)turn.reply.clarification?.let{clarification->
                        Text(clarification.question,style=MaterialTheme.typography.titleMedium)
                        clarification.choices.orEmpty().forEach {choice->OutlinedButton(shape = LocalStorefrontButtonShape.current, onClick={send(choice)},enabled=!locked){Text(choice)}}
                    }
                    if(turn.interrupted) {
                        Text(t("Response interrupted. Check your bag before sending again; changes may already have been applied.","انقطع الرد. تحقق من سلتك قبل الإرسال مجدداً؛ ربما تم تطبيق تغييرات بالفعل."),modifier=Modifier.testTag("assistant-interrupted"))
                        TextButton(onClick={navigate("cart")}){Text(t("Check bag","التحقق من السلة"))}
                    }
                }
            }
            if(chatState.busy)item {
                Row(horizontalArrangement=Arrangement.spacedBy(12.dp),verticalAlignment=Alignment.CenterVertically,modifier=Modifier.testTag("assistant-progress")) {
                    CircularProgressIndicator(Modifier.size(22.dp))
                    Text(when(chatState.stage){"catalog"->t("Checking the catalog…","جارٍ البحث في المنتجات…");"order"->t("Checking your order…","جارٍ التحقق من طلبك…");"support"->t("Contacting support…","جارٍ التواصل مع الدعم…");"responding"->t("Writing a response…","جارٍ كتابة الرد…");else->t("Understanding your request…","جارٍ فهم طلبك…")})
                }
            }
            if(chatState.signInRequired)item{TextButton(onClick={navigate("account")}){Text(t("Sign in to continue","سجّل الدخول للمتابعة"))}}
            shoppingState.error?.let{item{Text(it,color=MaterialTheme.colorScheme.error)}}
            shoppingState.notice?.let{item{Text(it,modifier=Modifier.testTag("assistant-cart-notice"))}}
        }
    }
}
@Composable private fun AssistantBlockView(block:AssistantBlock,shopping:ShoppingModel,locale:String,locked:Boolean,navigate:(String)->Unit,openProduct:(String)->Unit,send:(String,String?)->Unit) {
    val shoppingState = shoppingUiState(shopping)
    fun t(en:String,ar:String)=if(locale=="ar")ar else en
    Column(verticalArrangement=Arrangement.spacedBy(12.dp)) {
        block.title?.let{Text(it,style=MaterialTheme.typography.titleMedium)}
        block.text?.let{SelectionContainer{Text(it)}}
        block.products.orEmpty().forEach {product->
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(10.dp)) {
                    Row(horizontalArrangement=Arrangement.spacedBy(14.dp)) {
                        MerchantImage(product.image_id?.let{shopping.client.imageURL(it)},Modifier.size(88.dp).clip(RoundedCornerShape(12.dp)))
                        Column(Modifier.weight(1f),verticalArrangement=Arrangement.spacedBy(6.dp)) {
                            Text(product.name,style=MaterialTheme.typography.titleMedium)
                            Text("${product.price} ${product.currency}",fontWeight=FontWeight.Bold)
                            product.original_price?.let{Text("$it ${product.currency}",textDecoration=TextDecoration.LineThrough,style=MaterialTheme.typography.bodySmall)}
                            product.in_stock?.let{Text(if(it)t("Available","متوفر")else t("Out of stock","غير متوفر"),style=MaterialTheme.typography.bodySmall)}
                        }
                    }
                    product.reasons.forEach{Text(it,style=MaterialTheme.typography.bodyMedium)}
                    product.unmet.forEach{Text(it,style=MaterialTheme.typography.bodySmall)}
                    product.attributes.take(5).forEach{Text("${it.name}: ${it.value}",style=MaterialTheme.typography.bodySmall)}
                    Row(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                        TextButton(onClick={openProduct(product.id)},modifier=Modifier.weight(1f).testTag("assistant-product-${product.id}")){Text(t("View product","عرض المنتج"))}
                        Button(shape = LocalStorefrontButtonShape.current, onClick={if(shoppingState.customer==null || shoppingState.selectedLocation.isEmpty())navigate("account") else shopping.addAssistantProduct(product.id,locale,openProduct)},enabled=!locked && product.in_stock!=false,modifier=Modifier.weight(1f).testTag("assistant-add-${product.id}")){Text(t("Add to bag","إضافة للسلة"))}
                    }
                    TextButton(onClick={send(t("Tell me more about this product","أخبرني المزيد عن هذا المنتج"),product.id)},enabled=!locked){Text(t("Ask about this product","اسأل عن هذا المنتج"))}
                }
            }
        }
        block.rows.orEmpty().forEach {row->
            Text(row.label,style=MaterialTheme.typography.titleMedium)
            block.products.orEmpty().forEachIndexed{index,product->Text("${product.name}: ${row.values[index]}",style=MaterialTheme.typography.bodyMedium)}
        }
        when(block.kind) {
            "cart_summary" -> {
                block.cart.items("items").forEach{Text("${it.text("quantity")} × ${it.text("name")} · ${it.text("line_total")} ${block.cart.text("currency")}")}
                Text(t("Subtotal","المجموع الفرعي")+": ${block.cart.text("subtotal")} ${block.cart.text("currency")}",fontWeight=FontWeight.Bold)
                Button(shape = LocalStorefrontButtonShape.current, onClick={navigate("cart")},modifier=Modifier.testTag("assistant-checkout")){Text(t("View bag & checkout","عرض السلة وإتمام الطلب"))}
            }
            "cart_removal" -> {Text(block.cart_removal.text("name").orEmpty()+" · "+t("Remaining: ","المتبقي: ")+block.cart_removal.text("remaining_quantity"));TextButton(onClick={navigate("cart")}){Text(t("View bag","عرض السلة"))}}
            "cart_removal_choice" -> block.cart_removal_choice.items("items").forEach{item->OutlinedButton(shape = LocalStorefrontButtonShape.current, onClick={send(block.cart_removal_choice.text("quantity")?.toIntOrNull()?.let{"Remove $it of this product from my cart"} ?: "Remove this product from my cart",item.text("product_id"))},enabled=!locked){Text(item.text("name").orEmpty())}}
            "saved_addresses" -> TextButton(onClick={navigate("account")}){Text(t("Choose delivery address","اختيار عنوان التوصيل"))}
            "wishlist_manage","wishlist_transfer" -> TextButton(onClick={navigate("wishlist")}){Text(t("Open wishlist","فتح المفضلة"))}
            "action" -> TextButton(onClick={navigate("categories")}){Text(block.action.text("label") ?: t("Browse products","تصفح المنتجات"))}
            "product_prompt" -> block.product_prompt?.let{AssistantProductPromptView(it,shopping,locale,locked,openProduct){message,product->send(message,product)}}
            "basket_proposal" -> block.proposal_id?.let{AssistantProposalView(it,shopping,locale,locked,navigate)}
            "compound_choice" -> Text(t("Reply with the product and action you want to use.","أجب بالمنتج والإجراء الذي تريده."))
        }
    }
}
