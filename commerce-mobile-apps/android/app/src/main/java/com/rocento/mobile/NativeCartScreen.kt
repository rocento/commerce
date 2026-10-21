package com.rocento.mobile

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.ArrowForward
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.text.NumberFormat
import java.util.Currency
import java.util.Locale

// Read the active merchant theme on every recomposition, including checkout sheets.
private val CartBackground: Color @Composable get() = MaterialTheme.colorScheme.background
private val CartInk: Color @Composable get() = MaterialTheme.colorScheme.onSurface
private val CartMuted: Color @Composable get() = CartInk.copy(alpha = .7f)
private val CartLine: Color @Composable get() = CartInk.copy(alpha = .15f)
private val CartAccent: Color @Composable get() = MaterialTheme.colorScheme.primary
private val CartGreen: Color @Composable get() = MaterialTheme.colorScheme.primary

/** Always light, including sheets. Commercial facts are read from the merchant APIs. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable internal fun NativeCartScreen(shopping:ShoppingModel,locale:String,wishlistEnabled:Boolean,
    openProduct:(String)->Unit,openSaved:()->Unit,shop:()->Unit,openAssistant:()->Unit) {
    val shoppingState = shoppingUiState(shopping)
    fun t(en:String,ar:String)=if(locale=="ar")ar else en
    var summary by remember { mutableStateOf(false) }
    var coupon by remember { mutableStateOf("") }
    var addingAddress by remember { mutableStateOf(false) }
    val view=LocalView.current
    DisposableEffect(view) {
        val activity=generateSequence(view.context) { (it as? android.content.ContextWrapper)?.baseContext }.filterIsInstance<android.app.Activity>().firstOrNull()
        val controller=activity?.let { androidx.core.view.WindowCompat.getInsetsController(it.window,view) }
        val previousStatus=controller?.isAppearanceLightStatusBars
        val previousNavigation=controller?.isAppearanceLightNavigationBars
        controller?.isAppearanceLightStatusBars=true
        controller?.isAppearanceLightNavigationBars=true
        onDispose {
            if(previousStatus!=null)controller.isAppearanceLightStatusBars=previousStatus
            if(previousNavigation!=null)controller.isAppearanceLightNavigationBars=previousNavigation
        }
    }
    val cart=shoppingState.cart
    val locked=shoppingState.busy||shoppingState.uncertainCheckout
    val currency=cart?.currency ?: "EGP"
    val address=if(shoppingState.method=="pickup") shoppingState.availability?.methods?.firstOrNull{it.type=="pickup"}?.locations?.firstOrNull{it.id==shoppingState.source}?.name ?: t("Choose a branch","اختر فرعاً")
        else shoppingState.locations.firstOrNull{it.id==shoppingState.selectedLocation}?.formatted_address ?: t("Choose your delivery address","اختر عنوان التوصيل")
    LaunchedEffect(shoppingState.customer?.id) { shopping.cartPanel=null;coupon="" }
    LaunchedEffect(shoppingState.detail?.order?.id) { if(shoppingState.detail!=null)shopping.cartPanel=null }
    MaterialTheme(colorScheme=MaterialTheme.colorScheme) {
        Surface(color=CartBackground,contentColor=CartInk,modifier=Modifier.fillMaxSize().testTag("native-cart-light")) {
            Column(Modifier.fillMaxSize()) {
                Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).testTag("cart-scroll")) {
                    Surface(onClick={shopping.cartPanel="checkout"},enabled=!locked,shape=RoundedCornerShape(18.dp),color=MaterialTheme.colorScheme.surface,
                        border=androidx.compose.foundation.BorderStroke(1.dp,CartLine),modifier=Modifier.padding(horizontal=18.dp,vertical=12.dp).fillMaxWidth().testTag("cart-delivery")) {
                        Row(Modifier.padding(16.dp),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(12.dp)) {
                            Icon(if(shoppingState.method=="pickup") Icons.Outlined.Home else Icons.Outlined.LocationOn,null,tint=CartAccent)
                            Column(Modifier.weight(1f),verticalArrangement=Arrangement.spacedBy(5.dp)) {
                                Text(if(shoppingState.method=="pickup")t("Collect from store","الاستلام من المتجر") else t("Deliver to","التوصيل إلى"),fontWeight=FontWeight.SemiBold,style=MaterialTheme.typography.bodyMedium)
                                Text(address,style=MaterialTheme.typography.bodySmall,color=CartMuted,maxLines=2)
                                Text(if(shoppingState.asap)t("As soon as available","في أقرب وقت متاح") else shoppingState.date,style=MaterialTheme.typography.bodySmall,color=CartMuted)
                            }
                            Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight,null,Modifier.size(18.dp))
                        }
                    }
                    if(shoppingState.cartPanel==null)CartFeedback(shopping,locale,Modifier.padding(horizontal=20.dp))
                    if(shoppingState.customer==null) Column(Modifier.padding(20.dp)) { AccountSignIn(shopping,locale) }
                    else if(cart!=null) {
                        if(cart.items.isEmpty()) {
                            shoppingState.detail?.let { detail -> CartConfirmation(detail,shopping,locale) }
                            Column(Modifier.fillMaxWidth().padding(30.dp),horizontalAlignment=Alignment.CenterHorizontally,verticalArrangement=Arrangement.spacedBy(16.dp)) {
                                Box(Modifier.size(96.dp).background(CartAccent.copy(alpha=.08f),CircleShape),contentAlignment=Alignment.Center) { Icon(StoreIcons.Bag,null,Modifier.size(38.dp),CartAccent) }
                                Text(t("Your bag is empty","حقيبتك فارغة"),style=MaterialTheme.typography.headlineSmall,fontWeight=FontWeight.Bold,modifier=Modifier.testTag("cart-empty"))
                                Text(t("Fresh favourites and everyday essentials, all in one place.","منتجاتك المفضلة واحتياجاتك اليومية، كلها في مكان واحد."),color=CartMuted,textAlign=androidx.compose.ui.text.style.TextAlign.Center)
                                CartPrimary(t("Explore the store","تصفّح المتجر"),onClick=shop)
                            }
                        } else {
                            Row(Modifier.padding(horizontal=22.dp,vertical=16.dp),horizontalArrangement=Arrangement.spacedBy(8.dp),verticalAlignment=Alignment.CenterVertically) {
                                Icon(if(cart.fully_reserved)Icons.Outlined.CheckCircle else Icons.Outlined.Warning,null,Modifier.size(18.dp),if(cart.fully_reserved)CartMuted else MaterialTheme.colorScheme.error)
                                Text(if(cart.fully_reserved)t("Availability checked for your cart","تم التحقق من توفر المنتجات") else t("Availability changed. Update your bag before checkout.","تغير التوفر. حدّث الحقيبة قبل إتمام الطلب."),style=MaterialTheme.typography.bodySmall,color=if(cart.fully_reserved)CartMuted else MaterialTheme.colorScheme.error,modifier=Modifier.testTag("cart-availability"))
                            }
                            Column(Modifier.background(MaterialTheme.colorScheme.surface).padding(horizontal=20.dp)) {
                                cart.items.forEachIndexed { index,item ->
                                    key(item.product_id) { CartProductRow(item,currency,shopping,locale,wishlistEnabled,openProduct) }
                                    if(index<cart.items.lastIndex)HorizontalDivider(color=CartLine)
                                }
                            }
                            TextButton(onClick={coupon=cart.coupon_code.orEmpty();shopping.cartPanel="coupon"},enabled=!locked,modifier=Modifier.fillMaxWidth().padding(horizontal=14.dp).heightIn(min=54.dp).testTag("cart-coupon")) {
                                Icon(StoreIcons.Deals,null,Modifier.size(20.dp));Spacer(Modifier.width(12.dp))
                                Text(cart.coupon_code ?: t("Offers & promo codes","العروض وأكواد الخصم"),Modifier.weight(1f),color=CartInk)
                                Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight,null,Modifier.size(18.dp),CartMuted)
                            }
                            cart.coupon_error?.let { Text(it,color=MaterialTheme.colorScheme.error,modifier=Modifier.padding(horizontal=22.dp)) }
                            HorizontalDivider(Modifier.padding(horizontal=22.dp),color=CartLine)
                            TextButton(onClick={summary=!summary},modifier=Modifier.fillMaxWidth().padding(horizontal=14.dp).testTag("cart-summary")) {
                                Text(t("Order summary","ملخص الطلب"),Modifier.weight(1f),color=CartInk)
                                Icon(if(summary)Icons.Outlined.KeyboardArrowUp else Icons.Outlined.KeyboardArrowDown,null)
                            }
                            if(summary)Column(Modifier.padding(start=22.dp,end=22.dp,bottom=20.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
                                CartAmount(t("Subtotal","المجموع الفرعي"),cart.subtotal,currency,locale)
                                CartAmount(t("Discount","الخصم"),cart.discount_amount ?: "0",currency,locale,true)
                                Text(t("Delivery and applicable tax are confirmed at checkout.","تُؤكّد رسوم التوصيل والضرائب المطبّقة عند إتمام الشراء."),style=MaterialTheme.typography.bodySmall,color=CartMuted)
                            }
                        }
                    } else if(!shoppingState.busy) TextButton(onClick={shopping.load()},modifier=Modifier.padding(20.dp)) { Text(t("Retry loading your cart","إعادة تحميل السلة")) }
                }
                if(shoppingState.customer!=null && (cart?.items?.isNotEmpty()==true || shoppingState.uncertainCheckout)) {
                    CompositionLocalProvider(androidx.compose.ui.platform.LocalLayoutDirection provides androidx.compose.ui.unit.LayoutDirection.Ltr) {
                        Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface).padding(20.dp),horizontalArrangement=Arrangement.spacedBy(16.dp),verticalAlignment=Alignment.CenterVertically) {
                            Column(Modifier.weight(1f),verticalArrangement=Arrangement.spacedBy(4.dp)) {
                                Text(t("Items total","إجمالي المنتجات"),style=MaterialTheme.typography.bodySmall)
                                Text(cartMoney(cart?.itemsTotal ?: "0",currency,locale),style=MaterialTheme.typography.titleLarge,fontWeight=FontWeight.Bold,modifier=Modifier.testTag("cart-items-total"))
                            }
                            Box(Modifier.weight(1f)) {
                                CartPrimary(if(shoppingState.uncertainCheckout)t("Resolve pending order","متابعة الطلب المعلّق") else t("Checkout","إتمام الشراء"),
                                    enabled=!shoppingState.busy && (shoppingState.uncertainCheckout || cart?.fully_reserved==true),tag="cart-checkout",onClick={shopping.cartPanel="checkout"})
                            }
                        }
                    }
                }
            }
        }
        if(shoppingState.cartPanel!=null) ModalBottomSheet(onDismissRequest={shopping.cartPanel=null},sheetState=rememberModalBottomSheetState(skipPartiallyExpanded=true),containerColor=CartBackground,contentColor=CartInk) {
            Column(Modifier.fillMaxWidth().fillMaxHeight(.9f).imePadding().verticalScroll(rememberScrollState()).padding(horizontal=22.dp).padding(bottom=24.dp),verticalArrangement=Arrangement.spacedBy(18.dp)) {
                Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically) {
                    Text(if(shoppingState.cartPanel=="coupon")t("Offers & promo codes","العروض وأكواد الخصم") else t("Checkout","إتمام الشراء"),Modifier.weight(1f),style=MaterialTheme.typography.headlineSmall,fontWeight=FontWeight.Bold)
                    IconButton(onClick={shopping.cartPanel=null}) { Icon(Icons.Outlined.Close,t("Close","إغلاق")) }
                }
                CartFeedback(shopping,locale)
                if(shoppingState.cartPanel=="coupon") {
                    OutlinedTextField(coupon,{coupon=it},label={Text(t("Promo code","كود الخصم"))},singleLine=true,modifier=Modifier.fillMaxWidth().testTag("cart-coupon-input"))
                    CartPrimary(t("Apply code","تطبيق الكود"),!locked&&coupon.isNotBlank(),"cart-coupon-apply") { shopping.applyCoupon(coupon) }
                    cart?.coupon_error?.let { Text(it,color=MaterialTheme.colorScheme.error,modifier=Modifier.testTag("cart-coupon-error")) }
                    cart?.coupon_code?.let { code ->
                        Text(code,fontWeight=FontWeight.Bold)
                        CartAmount(t("Discount","الخصم"),cart.discount_amount ?: "0",currency,locale,true)
                        TextButton(onClick={shopping.applyCoupon("")},enabled=!locked) { Text(t("Remove code","إزالة الكود")) }
                    }
                    Text(t("Eligible offers are applied by the store. Your final savings appear in the order review.","يطبّق المتجر العروض المؤهلة، ويظهر الخصم النهائي عند مراجعة الطلب."),style=MaterialTheme.typography.bodySmall,color=CartMuted)
                } else {
                    shoppingState.quote?.let { quote -> CartReview(quote,shopping,locale,address) }
                        ?: CartDelivery(shopping,locale) { addingAddress=true }
                }
            }
        }
        if(addingAddress) AddressDialog(shopping,locale) { addingAddress=false }
    }
}

@Composable private fun CartProductRow(item:CommerceCartItem,currency:String,shopping:ShoppingModel,locale:String,wishlistEnabled:Boolean,openProduct:(String)->Unit) {
    val shoppingState = shoppingUiState(shopping)
    fun t(en:String,ar:String)=if(locale=="ar")ar else en
    var product by remember(item.product_id,locale,shoppingState.selectedLocation) { mutableStateOf<Product?>(null) }
    LaunchedEffect(item.product_id,locale,shoppingState.selectedLocation) {
        try { product=shopping.client.product(item.product_id,locale) }
        catch(e:Exception) { if(e is kotlinx.coroutines.CancellationException)throw e /* Optional artwork cannot block shopping. */ }
    }
    val locked=shoppingState.busy||shoppingState.uncertainCheckout
    Row(Modifier.padding(vertical=14.dp).testTag("cart-item-${item.product_id}"),horizontalArrangement=Arrangement.spacedBy(12.dp),verticalAlignment=Alignment.Top) {
        Surface(onClick={openProduct(item.product_id)},enabled=!locked,color=MaterialTheme.colorScheme.surface,shape=RoundedCornerShape(14.dp),modifier=Modifier.width(if(LocalDensity.current.fontScale>1.3f)52.dp else 78.dp).height(88.dp)) {
            MerchantImage(product?.thumbnail?.let{shopping.client.imageURL(it)},Modifier.fillMaxSize())
        }
        Column(Modifier.weight(1f),verticalArrangement=Arrangement.spacedBy(6.dp)) {
            Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.Top) {
                Text(item.name,Modifier.weight(1f),style=MaterialTheme.typography.bodyMedium,fontWeight=FontWeight.SemiBold)
                if(wishlistEnabled) IconButton(onClick={shopping.saveCartItem(item)},enabled=!locked,modifier=Modifier.size(44.dp).testTag("cart-save-${item.product_id}")) { Icon(StoreIcons.Bookmark,t("Save for later: ","حفظ لوقت لاحق: ")+item.name,Modifier.size(18.dp),CartMuted) }
            }
            item.unit?.takeIf{it.isNotBlank()}?.let { Text(it,style=MaterialTheme.typography.bodySmall,color=CartMuted) }
            BoxWithConstraints(Modifier.fillMaxWidth()) {
                val price:@Composable ()->Unit={ Text(cartMoney(item.line_total,currency,locale),style=MaterialTheme.typography.bodyMedium,fontWeight=FontWeight.SemiBold) }
                if(maxWidth<240.dp || LocalDensity.current.fontScale>1.2f) Column(verticalArrangement=Arrangement.spacedBy(8.dp)) { price();CartStepper(item,shopping,locale) }
                else Row(verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.SpaceBetween,modifier=Modifier.fillMaxWidth()) { price();CartStepper(item,shopping,locale) }
            }
            if(item.reserved_quantity<item.quantity)Text(t("Only ${item.reserved_quantity} reserved. Reduce the quantity or remove this item.","تم حجز ${item.reserved_quantity} فقط. قلّل الكمية أو احذف المنتج."),style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.error)
        }
    }
}
@Composable private fun CartStepper(item:CommerceCartItem,shopping:ShoppingModel,locale:String) {
    val shoppingState = shoppingUiState(shopping)
    val enabled=!shoppingState.busy&&!shoppingState.uncertainCheckout
    Row(Modifier.background(CartBackground,RoundedCornerShape(12.dp)).border(1.dp,CartLine,RoundedCornerShape(12.dp)),verticalAlignment=Alignment.CenterVertically) {
        IconButton(onClick={shopping.quantity(item.product_id,item.quantity-1)},enabled=enabled,modifier=Modifier.size(44.dp).testTag("cart-decrease-${item.product_id}")) { Icon(if(item.quantity==1)Icons.Outlined.Delete else StoreIcons.Minus,(if(locale=="ar")"حذف وحدة من " else "Remove one ")+item.name,Modifier.size(18.dp)) }
        Text(item.quantity.toString(),Modifier.widthIn(min=22.dp),style=MaterialTheme.typography.bodyMedium,textAlign=androidx.compose.ui.text.style.TextAlign.Center)
        IconButton(onClick={shopping.quantity(item.product_id,item.quantity+1)},enabled=enabled&&item.quantity<Int.MAX_VALUE&&(item.available?.let{item.quantity<it}!=false)&&item.reserved_quantity==item.quantity,modifier=Modifier.size(44.dp).testTag("cart-increase-${item.product_id}")) { Icon(Icons.Outlined.Add,(if(locale=="ar")"إضافة وحدة من " else "Add one ")+item.name,Modifier.size(18.dp)) }
    }
}
@Composable private fun CartDelivery(shopping:ShoppingModel,locale:String,addAddress:()->Unit) {
    val shoppingState = shoppingUiState(shopping)
    fun t(en:String,ar:String)=if(locale=="ar")ar else en
    val checkoutState by shopping.checkout.state.collectAsStateWithLifecycle()
    val enabled=!shoppingState.busy&&!shoppingState.uncertainCheckout
    Text(t("Delivery your way","التوصيل كما يناسبك"),style=MaterialTheme.typography.titleLarge,fontWeight=FontWeight.Bold)
    OutlinedTextField(checkoutState.giftMessage, { shopping.checkout.setGiftMessage(it) }, enabled=enabled,
        label={Text(t("Gift message (optional)","رسالة هدية (اختياري)"))}, minLines=3, maxLines=6,
        isError=!checkoutState.giftMessageValid, modifier=Modifier.fillMaxWidth().testTag("gift-message"))
    if(!checkoutState.giftMessageValid)Text(t("Please shorten your gift message.","يرجى تقصير رسالة الهدية."),color=MaterialTheme.colorScheme.error)
    if(shoppingState.customer?.verified!=true)Text(t("Verify your account before checkout","أكد حسابك قبل إتمام الطلب"),color=MaterialTheme.colorScheme.error)
    val methods=shoppingState.availability?.methods.orEmpty()
    if(methods.isEmpty())Text(t("Delivery options are unavailable. Try refreshing your cart.","خيارات التوصيل غير متاحة. جرّب تحديث السلة."))
    methods.forEach { method ->
        FilterChip(selected=shoppingState.method==method.type,onClick={shopping.method=method.type;shopping.asap=method.asap==true},enabled=enabled,label={Text(if(method.type=="pickup")t("Store pickup","استلام من المتجر") else t("Delivery","التوصيل"))})
    }
    if(shoppingState.method=="pickup") methods.firstOrNull{it.type=="pickup"}?.locations.orEmpty().forEach { branch ->
        OutlinedButton(onClick={shopping.source=branch.id},enabled=enabled,modifier=Modifier.fillMaxWidth(),shape=RoundedCornerShape(14.dp)) { Text((if(shoppingState.source==branch.id)"✓ " else "")+branch.name) }
    } else {
        shoppingState.locations.forEach { location ->
            OutlinedButton(onClick={shopping.choose(location.id)},enabled=enabled,shape=RoundedCornerShape(14.dp),modifier=Modifier.fillMaxWidth().heightIn(min=48.dp)) { Text((if(shoppingState.selectedLocation==location.id)"✓ " else "")+location.formatted_address) }
        }
        OutlinedButton(onClick=addAddress,enabled=enabled,modifier=Modifier.fillMaxWidth(),shape=RoundedCornerShape(14.dp)) { Text(t("Add delivery address","إضافة عنوان توصيل")) }
    }
    if(methods.firstOrNull{it.type==shoppingState.method}?.let{it.asap==true&&it.scheduling}==true)Row(verticalAlignment=Alignment.CenterVertically) {
        Switch(shoppingState.asap,{shopping.asap=it},enabled=enabled)
        Text(t("As soon as possible","في أقرب وقت"),Modifier.padding(12.dp))
    }
    if(!shoppingState.asap)OutlinedTextField(shoppingState.date,{shopping.date=it},enabled=enabled,label={Text(t("Delivery date (YYYY-MM-DD)","تاريخ التوصيل (YYYY-MM-DD)"))},modifier=Modifier.fillMaxWidth())
    OutlinedButton(onClick={shopping.findOptions()},enabled=enabled&&shoppingState.canCheckDelivery,shape=RoundedCornerShape(13.dp),modifier=Modifier.fillMaxWidth().heightIn(min=50.dp).testTag("delivery-options")) { Text(t("Check availability","تحقق من التوفر")) }
    shoppingState.options?.let { options ->
        options.groups.forEach { group ->
            Text(group.source_name,style=MaterialTheme.typography.titleMedium)
            if(!shoppingState.asap) {
                val slots=group.slots.filter{it.availability=="AVAILABLE"}
                if(slots.isEmpty())Text(t("No slots available. Choose another date.","لا توجد مواعيد متاحة. اختر تاريخاً آخر."),color=MaterialTheme.colorScheme.error)
                slots.forEach { slot ->
                    TextButton(onClick={shopping.windows=shoppingState.windows+(group.source_id to slot)},enabled=enabled) { Text((if(shoppingState.windows[group.source_id]?.id==slot.id)"✓ " else "")+"${CommercePresentation.dateTime(slot.starts_at,locale)} – ${CommercePresentation.dateTime(slot.ends_at,locale)}") }
                }
            }
        }
        CartPrimary(t("Review order","مراجعة الطلب"),enabled&&shoppingState.canReviewCart&&checkoutState.giftMessageValid,"review-order") { shopping.review() }
    }
}
@Composable private fun CartReview(quote:CommerceQuote,shopping:ShoppingModel,locale:String,address:String) {
    val shoppingState = shoppingUiState(shopping)
    fun t(en:String,ar:String)=if(locale=="ar")ar else en
    val q=quote.snapshot
    Text(t("Review your order","راجع طلبك"),style=MaterialTheme.typography.titleLarge,fontWeight=FontWeight.Bold)
    q.gift_message?.takeIf { it.isNotEmpty() }?.let { Text(t("Gift message: ","رسالة الهدية: ")+it,modifier=Modifier.testTag("review-gift-message")) }
    Text(address)
    Text(if(q.payment_method=="cash_on_delivery")t("Cash on delivery","الدفع عند الاستلام") else q.payment_method)
    HorizontalDivider(color=CartLine)
    CartAmount(t("Subtotal","المجموع الفرعي"),q.subtotal,q.currency,locale)
    CartAmount(t("Discount","الخصم"),q.discount_amount,q.currency,locale,true)
    CartAmount(t("Delivery","التوصيل"),q.delivery_fee,q.currency,locale)
    CartAmount(t("Tax","الضريبة"),q.tax_amount,q.currency,locale)
    HorizontalDivider(color=CartLine)
    Text(t("Total","الإجمالي")+": "+cartMoney(q.total,q.currency,locale),style=MaterialTheme.typography.headlineSmall,fontWeight=FontWeight.Bold,modifier=Modifier.testTag("checkout-total"))
    Text(t("Quote expires","ينتهي العرض")+": "+CommercePresentation.dateTime(quote.expires_at,locale),style=MaterialTheme.typography.bodySmall,color=CartMuted,modifier=Modifier.testTag("quote-expiry"))
    if(shoppingState.uncertainCheckout)Text(t("The last result may be pending. Retry confirmation to safely retrieve the same order.","قد تكون نتيجة الطلب معلقة. أعد التأكيد لاسترجاع نفس الطلب بأمان."),color=CartAccent)
    CartPrimary(if(shoppingState.uncertainCheckout)t("Retry confirmation","إعادة التأكيد") else t("Place order","تأكيد الطلب"),!shoppingState.busy,"place-order") { shopping.place() }
    if(!shoppingState.uncertainCheckout)TextButton(onClick={shopping.resetDelivery()},enabled=!shoppingState.busy) { Text(t("Edit delivery","تعديل التوصيل")) }
}
@Composable private fun CartPrimary(label:String,enabled:Boolean=true,tag:String="",onClick:()->Unit) {
    Button(onClick=onClick,enabled=enabled,shape=LocalStorefrontButtonShape.current,colors=ButtonDefaults.buttonColors(containerColor=CartGreen,contentColor=MaterialTheme.colorScheme.onPrimary),modifier=Modifier.fillMaxWidth().heightIn(min=52.dp).testTag(tag)) { Text(label,fontWeight=FontWeight.SemiBold) }
}
@Composable private fun CartAmount(label:String,value:String,currency:String,locale:String,negative:Boolean=false) {
    Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(12.dp)) { Text(label,Modifier.weight(1f));Text((if(negative)"−" else "")+cartMoney(value,currency,locale)) }
}
@Composable private fun CartFeedback(shopping:ShoppingModel,locale:String,modifier:Modifier=Modifier) {
    val shoppingState = shoppingUiState(shopping)
    Column(modifier,verticalArrangement=Arrangement.spacedBy(8.dp)) {
        if(shoppingState.busy)LinearProgressIndicator(Modifier.fillMaxWidth())
        shoppingState.error?.let { Text(it,color=MaterialTheme.colorScheme.error,modifier=Modifier.testTag("commerce-error")) }
    }
}
@Composable private fun CartConfirmation(detail:CustomerOrderDetail,shopping:ShoppingModel,locale:String) {
    val shoppingState = shoppingUiState(shopping)
    fun t(en:String,ar:String)=if(locale=="ar")ar else en
    Column(Modifier.padding(20.dp).background(CartAccent.copy(alpha=.08f),RoundedCornerShape(18.dp)).padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
        Text(t("Your order is confirmed","تم تأكيد طلبك"),style=MaterialTheme.typography.headlineSmall,fontWeight=FontWeight.Bold)
        Text(t("Order","طلب")+" #${detail.order.number}",modifier=Modifier.testTag("order-confirmation"))
        Text(CommercePresentation.status(detail.order.status,locale),modifier=Modifier.testTag("order-status"))
        Text(CommercePresentation.dateTime(detail.order.created_at,locale),modifier=Modifier.testTag("order-date"))
        detail.history.forEach { Text(CommercePresentation.status(it.status,locale)+" · "+CommercePresentation.dateTime(it.created_at,locale),style=MaterialTheme.typography.bodySmall,modifier=Modifier.testTag("order-history-${it.id}")) }
        TextButton(onClick={shopping.track(detail.order.id)},enabled=!shoppingState.busy) { Text(t("Refresh status","تحديث الحالة")) }
    }
}
private fun cartMoney(value:String,currency:String,locale:String):String = runCatching {
    NumberFormat.getCurrencyInstance(Locale.forLanguageTag(if(locale=="ar")"ar-EG" else "en-EG")).apply { this.currency=Currency.getInstance(currency) }.format(value.toBigDecimal())
}.getOrDefault("$value $currency")
