package com.rocento.mobile

import kotlinx.coroutines.flow.first

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

@Composable internal fun NativeAccountScreen(shopping:ShoppingModel,locale:String,wishlistEnabled:Boolean,
    openWishlist:()->Unit,shop:()->Unit,toggleLanguage:()->Unit,openHelp:()->Unit) {
    val shoppingState = shoppingUiState(shopping)
    fun t(en:String,ar:String)=if(locale=="ar")ar else en

    var authMode by remember { mutableStateOf("login") }
    var addingAddress by remember { mutableStateOf(false) }
    var verification by remember { mutableStateOf(AuthenticationFormState(mode="verify")) }
    DisposableEffect(Unit) { onDispose { verification = verification.clearSecrets() } }
    val customer=shoppingState.customer
    LaunchedEffect(shopping,locale) { shopping.client.setLocale(locale);shopping.load() }
    LaunchedEffect(customer?.id) { verification=verification.clearSecrets() }
    LaunchedEffect(OrderPush.pendingOrder,customer?.id) {
        val id=OrderPush.pendingOrder
        if(id!=null && OrderPush.canOpen(customer?.id)) {
            shopping.accountScreen="notification-order";shopping.detail=null
            shopping.session.operations.loading.first { !it.busy }
            shopping.track(id);OrderPush.pendingOrder=null
        }
    }
    fun openOrder(id:String) { shopping.detail=null;shopping.accountScreen="order";shopping.track(id) }
    androidx.activity.compose.BackHandler(enabled=shoppingState.accountScreen!=null) { shopping.session.navigation.back() }
    Column(Modifier.fillMaxWidth(),verticalArrangement=Arrangement.spacedBy(20.dp)) {
        if(shoppingState.busy) LinearProgressIndicator(Modifier.fillMaxWidth().semantics { contentDescription=shoppingState.loading.label(locale) })
        shoppingState.error?.let { Text(it,color=MaterialTheme.colorScheme.error,modifier=Modifier.testTag("commerce-error")) }
        shoppingState.notice?.let { Text(it,modifier=Modifier.testTag("commerce-notice")) }
        if(shoppingState.accountScreen=="settings" || shoppingState.accountScreen=="notifications") {
            NativePreferencesView(shopping,locale,shoppingState.accountScreen!!,toggleLanguage,
                back={shopping.accountScreen=null},settings={shopping.accountScreen="settings"},openOrder={id->shopping.detail=shoppingState.notificationDetails.firstOrNull{it.order.id==id};shopping.accountScreen="notification-order"})
        } else if(shoppingState.accountScreen!=null) {
            TextButton(onClick={shopping.session.navigation.back()},modifier=Modifier.testTag("account-home")) {
                Text(t("My account","حسابي"))
            }
            when(shoppingState.accountScreen) {
                "auth" -> AccountSignIn(shopping,locale,authMode)
                "language" -> AccountLanguageCard(locale,toggleLanguage,!shoppingState.busy)
                "orders" -> {
                    Text(t("Your orders","طلباتك"),style=MaterialTheme.typography.headlineMedium)
                    if(shoppingState.orders.isEmpty()) AccountEmptyOrders(locale,shop)
                    shoppingState.orders.sortedByDescending{it.created_at}.forEach { order ->
                        AccountOrderCard(order,locale,!shoppingState.busy) { openOrder(order.id) }
                    }
                    TextButton(onClick={shopping.refreshOrders()},enabled=!shoppingState.busy) { Text(t("Refresh orders","تحديث الطلبات")) }
                    if(shoppingState.ordersHasMore && shoppingState.orders.isNotEmpty()) TextButton(onClick={shopping.refreshOrders(true)},enabled=!shoppingState.busy) { Text(t("Load more orders","تحميل المزيد من الطلبات")) }
                }
                "addresses" -> {
                    Text(t("Addresses","العناوين"),style=MaterialTheme.typography.headlineMedium)
                    if(shoppingState.locations.isEmpty()) Text(t("Save a delivery address for a faster checkout.","احفظ عنوان التوصيل لإتمام الشراء أسرع."))
                    shoppingState.locations.forEach { location ->
                        OutlinedButton(onClick={shopping.choose(location.id)},enabled=!shoppingState.busy,shape=RoundedCornerShape(16.dp),modifier=Modifier.fillMaxWidth()) {
                            Row(Modifier.fillMaxWidth().padding(vertical=12.dp),horizontalArrangement=Arrangement.spacedBy(12.dp)) {
                                Icon(if(shoppingState.selectedLocation==location.id) Icons.Outlined.CheckCircle else Icons.Outlined.LocationOn,null)
                                Column(Modifier.weight(1f),verticalArrangement=Arrangement.spacedBy(6.dp)) {
                                    Text(location.label,style=MaterialTheme.typography.titleMedium)
                                    Text(location.formatted_address)
                                    if(location.is_default) Text(t("Default address","العنوان الافتراضي"),style=MaterialTheme.typography.bodySmall)
                                }
                            }
                        }
                    }
                    Button(onClick={addingAddress=true},enabled=!shoppingState.busy,shape=LocalStorefrontButtonShape.current,modifier=Modifier.fillMaxWidth().heightIn(min=52.dp)) {
                        Text(t("Add delivery address","إضافة عنوان توصيل"))
                    }
                }
                "order", "notification-order" -> {
                    if(customer!=null) shoppingState.detail?.let { OrderDetailView(it,shopping,locale) }
                    if(shoppingState.detail==null && !shoppingState.busy) Text(t("No order details to show.","لا توجد تفاصيل طلب لعرضها."))
                    if(shoppingState.orderDetailFailed) shoppingState.selectedOrderID?.let { id -> TextButton(onClick={shopping.track(id)},enabled=!shoppingState.busy){Text(t("Retry","إعادة المحاولة"))} }
                }
            }
        } else {
            Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(12.dp)) {
                Text(t("My account","حسابي"),style=MaterialTheme.typography.headlineLarge,fontWeight=androidx.compose.ui.text.font.FontWeight.Bold,modifier=Modifier.weight(1f))
                OutlinedIconButton(onClick={shopping.accountScreen="notifications"},enabled=!shoppingState.busy,shape=RoundedCornerShape(14.dp),modifier=Modifier.size(48.dp).testTag("account-notifications")) {
                    Icon(Icons.Outlined.Notifications,t("Notifications","الإشعارات"))
                }
            }
            if(customer==null) {
                AccountGuestHeader(locale,wishlistEnabled,!shoppingState.busy,
                    signIn={authMode="login";shopping.accountScreen="auth"},register={authMode="register";shopping.accountScreen="auth"})
            } else {
                AccountIdentity(customer,locale)
                Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(10.dp)) {
                    AccountShortcut(t("Orders","الطلبات"),t("View all","عرض الكل"),AccountIcons.Inventory2,"account-orders",Modifier.weight(1f),!shoppingState.busy) { shopping.accountScreen="orders" }
                    if(wishlistEnabled) AccountShortcut(t("Wishlist","المفضلة"),t("Saved items","المحفوظات"),Icons.Outlined.FavoriteBorder,"account-wishlist",Modifier.weight(1f),!shoppingState.busy,openWishlist)
                    AccountShortcut(t("Addresses","العناوين"),"${shoppingState.locations.size} "+t("saved","محفوظة"),Icons.Outlined.LocationOn,"account-addresses",Modifier.weight(1f),!shoppingState.busy) { shopping.accountScreen="addresses" }
                }
                if(!customer.verified) {
                    Text(t("Verify your account before checkout","أكد حسابك قبل إتمام الطلب"),style=MaterialTheme.typography.titleMedium)
                    OutlinedTextField(verification.code,{verification=verification.copy(code=it)},label={Text(t("Verification code","رمز التحقق"))},modifier=Modifier.fillMaxWidth())
                    TextButton(onClick={shopping.auth("request-verification",customer.identifier)},enabled=!shoppingState.busy){Text(t("Send verification code","إرسال رمز التحقق"))}
                    Button(onClick={shopping.auth("verify",customer.identifier,code=verification.code) { verification=verification.clearSecrets() }},enabled=!shoppingState.busy,shape=LocalStorefrontButtonShape.current){Text(t("Verify","تأكيد"))}
                }
                Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically) {
                    Text(t("Latest order","أحدث طلب"),style=MaterialTheme.typography.titleLarge,modifier=Modifier.weight(1f))
                    TextButton(onClick={shopping.accountScreen="orders"},enabled=!shoppingState.busy){Text(t("View all","عرض الكل"))}
                }
                val latest=shoppingState.orders.maxByOrNull{it.created_at}
                if(latest!=null) AccountOrderCard(latest,locale,!shoppingState.busy) { openOrder(latest.id) }
                else AccountEmptyOrders(locale,shop)
            }
            AccountPreferences(locale,!shoppingState.busy,language={shopping.accountScreen="language"},notifications={shopping.accountScreen="notifications"},
                settings={shopping.accountScreen="settings"},help=openHelp,signOut=if(customer==null) null else { { shopping.logout() } })
        }
    }
    if(addingAddress) AddressDialog(shopping,locale) { addingAddress=false }
}

@Composable internal fun AccountEmptyOrders(locale:String,shop:()->Unit) {
    fun t(en:String,ar:String)=if(locale=="ar")ar else en
    AccountPanel {
        Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(8.dp)) {
            Text(t("No orders yet","لا توجد طلبات بعد"),style=MaterialTheme.typography.titleMedium)
            Text(t("Your orders and delivery updates will appear here.","ستظهر طلباتك وتحديثات التوصيل هنا."),style=MaterialTheme.typography.bodyMedium)
            TextButton(onClick=shop) { Text(t("Explore products","استكشف المنتجات")) }
        }
    }
}

@Composable internal fun OrderDetailView(detail:CustomerOrderDetail,shopping:ShoppingModel,locale:String) {
    val shoppingState = shoppingUiState(shopping)
    Text((if(locale=="ar")"طلب" else "Order")+" #${detail.order.number}",style=MaterialTheme.typography.titleMedium,modifier=Modifier.testTag("order-confirmation"))
    Text(CommercePresentation.status(detail.order.status,locale),modifier=Modifier.testTag("order-status"))
    Text((if(locale=="ar")"تاريخ الطلب" else "Ordered on")+": "+CommercePresentation.dateTime(detail.order.created_at,locale),modifier=Modifier.testTag("order-date"))
    OrderContentsView(detail,locale)
    SupportControls(shopping,locale,detail.order.id)
    detail.history.forEach { Text("${CommercePresentation.status(it.status,locale)} · ${CommercePresentation.dateTime(it.created_at,locale)}",modifier=Modifier.testTag("order-history-${it.id}")) }
    TextButton(onClick={shopping.track(detail.order.id)},enabled=!shoppingState.busy){Text(if(locale=="ar")"تحديث الحالة" else "Refresh status")}
    ReorderView(detail.order,shopping,locale)
}
