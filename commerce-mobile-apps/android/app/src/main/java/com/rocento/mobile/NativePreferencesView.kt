package com.rocento.mobile

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
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@Composable internal fun NativePreferencesView(shopping:ShoppingModel,locale:String,screen:String,toggleLanguage:()->Unit,
    back:()->Unit,settings:()->Unit,openOrder:(String)->Unit) {
    val shoppingState = shoppingUiState(shopping)
    fun t(en:String,ar:String)=if(locale=="ar")ar else en
    val store=shopping.session.notifications
    val state by store.state.collectAsStateWithLifecycle()
    val owner=shoppingState.customer?.id
    val read=state.read;val updates=state.enabled;val unreadOnly=state.unreadOnly
    val events=state.events;val unread=state.unread
    fun mark(ids:List<String>)=store.mark(ids)
    LaunchedEffect(screen,owner){store.bind(owner);if(screen=="notifications" && state.enabled)shopping.refreshNotifications()}
    Column(verticalArrangement=Arrangement.spacedBy(18.dp)) {
        TextButton(onClick=back){Text(t("My account","حسابي"))}
        Text(if(screen=="settings")t("App settings","إعدادات التطبيق") else t("Notifications","الإشعارات"),style=MaterialTheme.typography.headlineSmall)
        if(screen=="settings") {
            Text(t("Language","اللغة"),style=MaterialTheme.typography.titleMedium)
            Text(t("App language","لغة التطبيق"))
            Row { FilterChip(selected=locale=="en",onClick={if(locale!="en")toggleLanguage()},label={Text("English")});Spacer(Modifier.width(8.dp));FilterChip(selected=locale=="ar",onClick={if(locale!="ar")toggleLanguage()},label={Text("العربية")}) }
            HorizontalDivider()
            Text(t("Notifications","الإشعارات"),style=MaterialTheme.typography.titleMedium)
            Row(verticalAlignment=androidx.compose.ui.Alignment.CenterVertically){Switch(updates,{store.setEnabled(it)},modifier=Modifier.semantics { contentDescription=t("Show order updates","عرض تحديثات الطلبات") });Text(t("Show order updates","عرض تحديثات الطلبات"),Modifier.padding(start=12.dp))}
            OrderPushSettings(locale, shoppingState.customer != null)
            HorizontalDivider()
            Text(t("Privacy","الخصوصية"),style=MaterialTheme.typography.titleMedium)
            Row(verticalAlignment=androidx.compose.ui.Alignment.CenterVertically){Switch(shoppingState.analyticsEnabled,{shopping.consent(it)},enabled=!shoppingState.busy,modifier=Modifier.semantics { contentDescription=t("Share anonymous usage analytics","مشاركة إحصاءات استخدام مجهولة") });Text(t("Share anonymous usage analytics","مشاركة إحصاءات استخدام مجهولة"),Modifier.padding(start=12.dp))}
            Text(t("Optional screen and checkout counts. No account, order, search or location details are sent.","إحصاءات اختيارية للشاشات وإتمام الشراء. لا تُرسل بيانات الحساب أو الطلب أو البحث أو الموقع."),style=MaterialTheme.typography.bodySmall)
        } else {
            Row(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                FilterChip(selected=!unreadOnly,onClick={store.filterUnread(false)},label={Text(t("All","الكل"))})
                FilterChip(selected=unreadOnly,onClick={store.filterUnread(true)},label={Text(t("Unread","غير المقروءة")+" (${unread.size})")})
            }
            TextButton(onClick={mark(events.map{it.id})},enabled=updates&&unread.isNotEmpty()){Text(t("Mark all read","تحديد الكل كمقروء"))}
            if(!updates) {
                Text(t("Order updates are paused","تحديثات الطلبات متوقفة"),style=MaterialTheme.typography.titleMedium)
                TextButton(onClick=settings){Text(t("Notification settings","إعدادات الإشعارات"))}
            } else if(owner==null) Text(t("Sign in to see order updates","سجّل الدخول لعرض تحديثات الطلبات"))
            else if((if(unreadOnly)unread else events).isEmpty())Text(if(unreadOnly)t("You’re all caught up","قرأت كل التحديثات")else t("No updates yet","لا توجد تحديثات بعد"),style=MaterialTheme.typography.titleMedium)
            else (if(unreadOnly)unread else events).forEach { event ->
                TextButton(onClick={mark(listOf(event.id));openOrder(event.order)},enabled=!shoppingState.busy) {
                    Row(horizontalArrangement=Arrangement.spacedBy(12.dp),modifier=Modifier.fillMaxWidth()) {
                        Text(if(event.id in read)"○" else "●",modifier=Modifier.semantics { contentDescription=if(event.id in read)t("Read","مقروء") else t("Unread","غير مقروء") })
                        Column(verticalArrangement=Arrangement.spacedBy(8.dp)) {
                            Text(CommercePresentation.status(event.status,locale),style=MaterialTheme.typography.titleMedium)
                            Text(t("Order","طلب")+" #${event.number}")
                            Text(CommercePresentation.dateTime(event.date,locale),style=MaterialTheme.typography.bodySmall)
                            Text(t("View order","عرض الطلب"))
                        }
                    }
                }
                HorizontalDivider()
            }
            if(state.loading)LinearProgressIndicator(Modifier.fillMaxWidth().semantics { contentDescription=shoppingState.loading.label(locale) })
            if(state.failed)Text(t("Unable to load updates. Please retry.","تعذر تحميل التحديثات. حاول مجدداً."),color=MaterialTheme.colorScheme.error)
            if(state.hasMore)TextButton(onClick={shopping.refreshNotifications(true)},enabled=updates&&!shoppingState.busy){Text(t("Load more updates","عرض المزيد من التحديثات"))}
            TextButton(onClick={shopping.refreshNotifications()},enabled=updates&&owner!=null&&!shoppingState.busy){Text(t("Refresh updates","تحديث الإشعارات"))}
            OrderPushSettings(locale, shoppingState.customer != null)
        }
    }
}

@Composable internal fun AccountLanguageCard(locale:String,toggleLanguage:()->Unit,enabled:Boolean) {
    fun t(en:String,ar:String)=if(locale=="ar")ar else en
    Surface(shape=RoundedCornerShape(16.dp),color=MaterialTheme.colorScheme.surface,tonalElevation=1.dp,modifier=Modifier.fillMaxWidth().testTag("account-language")) {
        Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(10.dp)) {
            Text(t("Language","اللغة"),style=MaterialTheme.typography.titleMedium)
            Row(horizontalArrangement=Arrangement.spacedBy(10.dp)) {
                listOf("en" to "English","ar" to "العربية").forEach { (value,label) ->
                    FilterChip(selected=locale==value,onClick={if(locale!=value)toggleLanguage()},enabled=enabled,
                        label={Text(label,style=MaterialTheme.typography.labelLarge)},
                        leadingIcon={if(locale==value)Icon(Icons.Outlined.Check,null,Modifier.size(18.dp))},
                        modifier=Modifier.weight(1f).heightIn(min=48.dp).testTag("account-language-$value"))
                }
            }
        }
    }
}



