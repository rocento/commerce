package com.rocento.mobile

import android.content.Intent
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.time.Instant

@Composable fun AssistantLibraryControls(shopping:ShoppingModel,chat:AssistantChatModel,locale:String) {
    val shoppingState = shoppingUiState(shopping)
    val chatState by chat.store.state.collectAsStateWithLifecycle()
    var presented by remember{mutableStateOf(false)}
    fun t(en:String,ar:String)=if(locale=="ar")ar else en
    TextButton(onClick={presented=true},enabled=!shoppingState.busy && !chatState.busy && !shoppingState.uncertainCheckout){Text(t("Conversations & memory","المحادثات والذاكرة"))}
    if(presented)Dialog(onDismissRequest={presented=false},properties=DialogProperties(usePlatformDefaultWidth=false)) {
        Surface(Modifier.fillMaxSize()){Column(Modifier.safeDrawingPadding().imePadding().padding(20.dp)) {
            TextButton(onClick={presented=false}){Text(t("Back to chat","العودة للمحادثة"))}
            Column(Modifier.verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(16.dp)) {key(shoppingState.customer?.id){AssistantLibraryContent(shopping,chat,locale){presented=false}}}
        }}
    }
}
@Composable private fun AssistantLibraryContent(shopping:ShoppingModel,chat:AssistantChatModel,locale:String,close:()->Unit) {
    val shoppingState = shoppingUiState(shopping)
    val chatState by chat.store.state.collectAsStateWithLifecycle()
    val library=shopping.session.library;val state by library.state.collectAsStateWithLifecycle();val owner=shoppingState.customer?.id
    var search by remember{mutableStateOf("")};var confirmation by remember{mutableStateOf<MemoryAction?>(null)}
    val names=remember{mutableStateMapOf<String,String>()};val context=LocalContext.current
    val busy=shoppingState.busy || chatState.busy || state.busy || shoppingState.uncertainCheckout;val writeLocked=busy || state.needsRefresh
    fun t(en:String,ar:String)=if(locale=="ar")ar else en
    fun label(value:String)=mapOf("product" to t("Product","منتج"),"brand" to t("Brand","علامة تجارية"),"color" to t("Color","لون"),"style" to t("Style","نمط"),"metal" to t("Metal","معدن"),"material" to t("Material","خامة"),"any" to t("Any occasion","أي مناسبة"),"everyday" to t("Everyday","يومي"),"gift" to t("Gift","هدية"),"work" to t("Work","عمل"),"travel" to t("Travel","سفر"),"self" to t("Me","أنا"),"other" to t("Someone else","شخص آخر"),"view" to t("Viewed","تمت مشاهدته"),"purchase" to t("Purchased","تم شراؤه"),"return" to t("Returned","تم إرجاعه"))[value] ?: value
    fun mutate(action:MemoryAction){shopping.act{library.mutate(action,chat.store.conversationID,shoppingState.customer!=null)}}
    fun open(id:String){shopping.act(OperationKind.Refresh){library.open(id){chat.store.restoreConversation(id,it);close()}}}
    fun refresh(){shopping.act(OperationKind.Refresh){library.refresh(chat.store.conversationID,shoppingState.customer!=null)}}
    LaunchedEffect(owner,chat.store.conversationID){shopping.session.perform(OperationKind.Refresh,locale){library.refresh(chat.store.conversationID,owner!=null)}}
    DisposableEffect(library){onDispose{library.clearExport()}}
    Text(t("Conversations & memory","المحادثات والذاكرة"),style=MaterialTheme.typography.titleLarge)
    if(state.busy)LinearProgressIndicator(Modifier.fillMaxWidth())
    shoppingState.error?.let{Text(it,color=MaterialTheme.colorScheme.error)}
    if(state.failed)Text(t("Unable to complete the request. Refresh to check the current state.","تعذر إكمال الطلب. حدّث للتحقق من الحالة الحالية."),color=MaterialTheme.colorScheme.error)
    if(state.changed)Text(t("Memory change saved","تم حفظ تغيير الذاكرة"))
    if(state.needsRefresh)Text(t("Refresh before making another change. The previous change may already be saved.","حدّث قبل إجراء تغيير آخر. ربما تم حفظ التغيير السابق."))
    TextButton(onClick={refresh()},enabled=!busy){Text(t("Refresh conversations & memory","تحديث المحادثات والذاكرة"))}
    Button(onClick={chat.reset();close()},enabled=!busy){Text(t("New conversation","محادثة جديدة"))}
    LibraryToggle(t("Do not personalize this request","عدم تخصيص هذا الطلب"),!chat.store.personalize,!busy){chat.store.personalize=!it}
    if(owner!=null){
        OutlinedTextField(search,{search=it},label={Text(t("Search conversations","البحث في المحادثات"))},modifier=Modifier.fillMaxWidth())
        if(state.loaded && library.conversations(search).isEmpty())Text(t("No matching conversations","لا توجد محادثات مطابقة"))
        library.conversations(search).forEach{conversation->TextButton(onClick={open(conversation.id)},enabled=!busy){Column(Modifier.fillMaxWidth()){Text(conversation.title);Text(CommercePresentation.dateTime(conversation.updated,locale),style=MaterialTheme.typography.bodySmall)}};HorizontalDivider()}
    }else Text(t("Sign in to view conversations","سجل الدخول لعرض المحادثات"))
    state.memory?.let { memory ->
        if(!memory.enabled)Text(t("Memory is unavailable for this store","الذاكرة غير متاحة لهذا المتجر"))
        else {
            Text(t("Memory & personalization","الذاكرة والتخصيص"),style=MaterialTheme.typography.titleLarge)
            Text(if(memory.guest)t("Guest catalog context expires within one hour and is not merged into an account.","تنتهي صلاحية سياق الضيف خلال ساعة ولا يُدمج في الحساب.")else t("Catalog context expires within one day. Saved goals are managed separately.","تنتهي صلاحية سياق المنتجات خلال يوم. تُدار الأهداف المحفوظة بشكل منفصل."),style=MaterialTheme.typography.bodySmall)
            LibraryToggle(t("Use my saved preferences","استخدام تفضيلاتي المحفوظة"),memory.personalized,!writeLocked){mutate(MemoryAction.Consent(it,it && memory.journey_consent,memory.consent_version))}
            LibraryToggle(t("Use recent product views and purchases","استخدام المشاهدات والمشتريات الأخيرة"),memory.journey_consent,!writeLocked && !memory.guest && memory.personalized){mutate(MemoryAction.Consent(memory.personalized,it,memory.consent_version))}
            val p=state.draft
            if(memory.personalized){
                LibraryChoice(t("Category","الفئة"),p.category_id,memory.categories.map{it.id to it.name},!writeLocked){library.edit(p.copy(category_id=it))}
                LibraryChoice(t("Preference","التفضيل"),p.attribute,preferenceAttributes.map{it to label(it)},!writeLocked){library.edit(p.copy(attribute=it,value=""))}
                if(p.attribute=="product")LibraryChoice(t("Recently suggested product","منتج مقترح مؤخراً"),p.value,memory.products.map{it.id to it.name},!writeLocked){id->library.edit(p.copy(value=id,category_id=memory.products.firstOrNull{it.id==id}?.category_id ?: p.category_id))}
                else OutlinedTextField(p.value,{library.edit(p.copy(value=it))},label={Text(t("Preference value","قيمة التفضيل"))},enabled=!writeLocked,modifier=Modifier.fillMaxWidth())
                LibraryChoice(t("For","لمن"),p.recipient,listOf("self","other").map{it to label(it)},!writeLocked){library.edit(p.copy(recipient=it))}
                LibraryChoice(t("Occasion","المناسبة"),p.occasion,memoryOccasions.map{it to label(it)},!writeLocked){library.edit(p.copy(occasion=it))}
                LibraryToggle(t("I dislike this option","لا أفضل هذا الخيار"),p.dislike,!writeLocked){library.edit(p.copy(dislike=it))}
                Button(onClick={mutate(MemoryAction.Preference(p))},enabled=!writeLocked && p.valid(memory)){Text(if(p.replaces==null)t("Save preference","حفظ التفضيل")else t("Update preference","تحديث التفضيل"))}
                if(p.replaces!=null)TextButton(onClick={library.edit(MemoryPreferenceInput())},enabled=!writeLocked){Text(t("Cancel edit","إلغاء التعديل"))}
            }
            Text(t("Saved preferences","التفضيلات المحفوظة"),style=MaterialTheme.typography.titleMedium)
            if(memory.preferences.isEmpty())Text(t("No saved preferences","لا توجد تفضيلات محفوظة"))
            memory.preferences.forEach{preference->
                Text((if(preference.signal=="explicit_dislike")t("Dislike","لا أفضل")else t("Prefer","أفضل"))+" "+label(preference.attribute)+": "+(if(preference.attribute=="product")memory.products.firstOrNull{it.id==preference.value}?.name ?: t("Saved product","منتج محفوظ")else preference.value))
                Text(label(preference.recipient)+" · "+label(preference.occasion))
                TextButton(onClick={library.edit(preference.input)},enabled=!writeLocked && memory.personalized){Text(t("Edit preference","تعديل التفضيل"))}
                TextButton(onClick={confirmation=MemoryAction.RemovePreference(preference.id)},enabled=!writeLocked){Text(t("Remove preference","إزالة التفضيل"))};HorizontalDivider()
            }
            Text(t("Recent signals used","الإشارات الأخيرة المستخدمة"),style=MaterialTheme.typography.titleMedium)
            if(memory.signals.isEmpty())Text(t("No eligible recent signals","لا توجد إشارات حديثة مؤهلة"))
            memory.signals.forEach{Text(label(it.kind)+" "+it.name)}
            TextButton(onClick={confirmation=MemoryAction.ClearContext(chat.store.conversationID)},enabled=!writeLocked){Text(t("Forget this context","نسيان هذا السياق"))}
            TextButton(onClick={shopping.act(OperationKind.Refresh){library.export()}},enabled=!busy){Text(t("Export memory","تصدير الذاكرة"))}
            state.exported?.let { value->TextButton(onClick={context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply{type="application/json";putExtra(Intent.EXTRA_TEXT,value);putExtra(Intent.EXTRA_TITLE,"rocento-memory.json")},t("Share JSON","مشاركة JSON")))},enabled=!busy){Text(t("Share JSON","مشاركة JSON"))} }
            TextButton(onClick={confirmation=MemoryAction.Delete},enabled=!writeLocked){Text(t("Delete personal memory","حذف الذاكرة الشخصية"))}
            Text(t("Deleting memory turns personalization off. Saved goals and orders are separate.","حذف الذاكرة يوقف التخصيص. الأهداف والطلبات منفصلة."),style=MaterialTheme.typography.bodySmall)
            Text(t("Saved goals","الأهداف المحفوظة"),style=MaterialTheme.typography.titleLarge)
            if(owner==null)Text(t("Sign in to manage saved goals","سجل الدخول لإدارة الأهداف المحفوظة"))
            else if(state.goals.isEmpty())Text(t("No saved goals","لا توجد أهداف محفوظة"))
            state.goals.forEach{goal->
                OutlinedTextField(names[goal.task_id] ?: goal.name,{names[goal.task_id]=it},label={Text(t("Goal name","اسم الهدف"))},enabled=!writeLocked,modifier=Modifier.fillMaxWidth())
                Text((if(goal.archived)t("Archived","مؤرشف")else goal.state.orEmpty())+" · "+CommercePresentation.dateTime(goal.expires_at,locale))
                TextButton(onClick={shopping.act(OperationKind.Refresh){library.resumeGoal(goal.task_id){chat.store.restoreConversation(goal.task_id,it);close()}}},enabled=!busy && !goal.archived && runCatching{Instant.parse(goal.expires_at).isAfter(Instant.now())}.getOrDefault(false)){Text(t("Continue goal","متابعة الهدف"))}
                TextButton(onClick={mutate(MemoryAction.Goal(goal,names[goal.task_id] ?: goal.name,goal.archived))},enabled=!writeLocked && (names[goal.task_id] ?: goal.name).isNotBlank()){Text(t("Rename goal","إعادة تسمية الهدف"))}
                TextButton(onClick={mutate(MemoryAction.Goal(goal,goal.name,!goal.archived))},enabled=!writeLocked){Text(if(goal.archived)t("Unarchive goal","إلغاء أرشفة الهدف")else t("Archive goal","أرشفة الهدف"))}
                TextButton(onClick={confirmation=MemoryAction.DeleteGoal(goal)},enabled=!writeLocked){Text(t("Delete goal","حذف الهدف"))};HorizontalDivider()
            }
        }
    }
    confirmation?.let{action->AlertDialog(onDismissRequest={confirmation=null},title={Text(t("Confirm removal?","تأكيد الإزالة؟"))},text={Text(t("Completed orders will not be deleted.","لن تُحذف الطلبات المكتملة."))},confirmButton={TextButton(onClick={confirmation=null;mutate(action)},enabled=!writeLocked){Text(t("Confirm removal","تأكيد الإزالة"))}},dismissButton={TextButton(onClick={confirmation=null}){Text(t("Cancel","إلغاء"))}})}
}
@Composable private fun LibraryToggle(label:String,value:Boolean,enabled:Boolean,change:(Boolean)->Unit){Row(Modifier.fillMaxWidth()){Text(label,Modifier.weight(1f).padding(top=12.dp));Switch(value,change,enabled=enabled,modifier=Modifier.semantics{contentDescription=label})}}
@Composable private fun LibraryChoice(title:String,value:String,values:List<Pair<String,String>>,enabled:Boolean,choose:(String)->Unit){var expanded by remember{mutableStateOf(false)};Box{TextButton(onClick={expanded=true},enabled=enabled){Text(title+": "+(values.firstOrNull{it.first==value}?.second ?: "—"))};DropdownMenu(expanded,{expanded=false}){values.forEach{(id,name)->DropdownMenuItem(text={Text(name)},onClick={choose(id);expanded=false},enabled=enabled)}}}}
