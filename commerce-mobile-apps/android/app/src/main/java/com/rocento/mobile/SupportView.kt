package com.rocento.mobile

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@Composable fun SupportControls(shopping:ShoppingModel,locale:String,order:String?=null,ticket:String?=null,label:String?=null,showTickets:Boolean=false) {
    val shoppingState = shoppingUiState(shopping)
    var presented by remember { mutableStateOf(false) }
    fun t(en:String,ar:String)=if(locale=="ar")ar else en
    TextButton(onClick={if(showTickets)shopping.session.support.showList();if(order!=null)shopping.session.support.compose(order);if(ticket!=null)shopping.act(OperationKind.Refresh){shopping.session.support.open(ticket)};presented=true},enabled=!shoppingState.busy && !shoppingState.uncertainCheckout && !shopping.assistant.busy){Text(label ?: if(ticket!=null)t("View support ticket","عرض تذكرة الدعم")else if(order==null)t("Support center","مركز الدعم")else t("Get help with this order","مساعدة بشأن هذا الطلب"))}
    if(presented)Dialog(onDismissRequest={presented=false},properties=DialogProperties(usePlatformDefaultWidth=false)) {
        Surface(Modifier.fillMaxSize()) {
            Column(Modifier.safeDrawingPadding().imePadding().padding(20.dp)) {
                TextButton(onClick={presented=false}){Text(t("Done","تم"))}
                Column(Modifier.verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(14.dp)) {
                    Text(t("Support center","مركز الدعم"),style=MaterialTheme.typography.titleLarge)
                    SupportContent(shopping,locale,{presented=false;shopping.session.navigation.open("auth")},{id->presented=false;shopping.session.navigation.open("order");shopping.track(id)})
                }
            }
        }
    }
}
@Composable private fun SupportContent(shopping:ShoppingModel,locale:String,signIn:()->Unit,openOrder:(String)->Unit) {
    val shoppingState = shoppingUiState(shopping)
    val store=shopping.session.support;val state by store.state.collectAsStateWithLifecycle()
    val customer=shoppingState.customer
    LaunchedEffect(customer?.id){if(customer!=null)shopping.session.perform(OperationKind.Refresh,locale){store.refresh()}}
    fun t(en:String,ar:String)=if(locale=="ar")ar else en
    fun label(value:String)=mapOf("order_issue" to t("Order issue","مشكلة في الطلب"),"product_question" to t("Product question","سؤال عن منتج"),"complaint" to t("Complaint","شكوى"),"payment_dispute" to t("Payment dispute","نزاع دفع"),"other" to t("Other","أخرى"),"open" to t("Open","مفتوحة"),"in_progress" to t("In progress","قيد المعالجة"),"resolved" to t("Resolved","تم الحل"),"closed" to t("Closed","مغلقة"),"high" to t("High priority","أولوية عالية"),"normal" to t("Normal priority","أولوية عادية"),"customer" to t("Customer","العميل"),"admin" to t("Support team","فريق الدعم"))[value] ?: value
    val locked=shoppingState.busy || state.busy || shoppingState.uncertainCheckout || shopping.assistant.busy
    fun open(id:String){shopping.act(OperationKind.Refresh){store.open(id)}}
    if(state.busy)LinearProgressIndicator(Modifier.fillMaxWidth())
    shoppingState.error?.let{Text(it,color=MaterialTheme.colorScheme.error)}
    if(state.failed)Text(t("The request could not be completed. Your draft is retained.","تعذر إكمال الطلب. تم الاحتفاظ بالمسودة."),color=MaterialTheme.colorScheme.error)
    TextButton(onClick={store.showList();if(customer!=null)shopping.act(OperationKind.Refresh){store.refresh()}},enabled=!locked){Text(t("Your tickets","تذاكرك"))}
    TextButton(onClick={store.compose()},enabled=!locked){Text(if(state.attempt==null)t("Open a ticket","فتح تذكرة")else t("Resume saved submission","متابعة الإرسال المحفوظ"))}
    state.replyAttempt?.takeIf{it.id!=state.selected}?.let { pending->TextButton(onClick={open(pending.id)},enabled=!locked){Text(t("Return to pending reply","العودة للرد المعلق"))} }
    if(state.composing) {
        state.draft.order_id?.let{id->
            TextButton(onClick={openOrder(id)},enabled=!locked){Text(t("Linked order","الطلب المرتبط"))}
            TextButton(onClick={store.edit(state.draft.copy(order_id=null))},enabled=!locked && state.attempt==null){Text(t("Remove linked order","إزالة الطلب المرتبط"))}
        }
        val editable=!locked && state.attempt==null
        OutlinedTextField(state.draft.subject,{store.edit(state.draft.copy(subject=it))},label={Text(t("Subject","الموضوع"))},enabled=editable,modifier=Modifier.fillMaxWidth())
        var expanded by remember{mutableStateOf(false)}
        Box {
            TextButton(onClick={expanded=true},enabled=editable){Text(t("Category","الفئة")+": "+label(state.draft.category))}
            DropdownMenu(expanded,{expanded=false}){supportCategories.forEach{category->DropdownMenuItem(text={Text(label(category))},onClick={store.edit(state.draft.copy(category=category));expanded=false},enabled=editable)}}
        }
        OutlinedTextField(state.draft.body,{store.edit(state.draft.copy(body=it))},label={Text(t("Message","الرسالة"))},minLines=4,enabled=editable,modifier=Modifier.fillMaxWidth())
        if(customer==null) {
            OutlinedTextField(state.draft.contact_name.orEmpty(),{store.edit(state.draft.copy(contact_name=it))},label={Text(t("Your name","اسمك"))},enabled=editable,modifier=Modifier.fillMaxWidth())
            OutlinedTextField(state.draft.contact.orEmpty(),{store.edit(state.draft.copy(contact=it))},label={Text(t("Email or mobile number","البريد الإلكتروني أو رقم الهاتف"))},enabled=editable,modifier=Modifier.fillMaxWidth())
        }
        Text(t("Subject: 160 bytes maximum. Message: 2000 bytes maximum.","الموضوع: ١٦٠ بايت كحد أقصى. الرسالة: ٢٠٠٠ بايت كحد أقصى."),style=MaterialTheme.typography.bodySmall)
        if(state.attempt!=null)Text(t("The result is unconfirmed. Retry the same saved submission.","النتيجة غير مؤكدة. أعد محاولة الإرسال المحفوظ نفسه."))
        Button(onClick={shopping.act{store.create(shoppingState.customer!=null)}},enabled=!locked && (state.attempt!=null || state.draft.valid(customer!=null))){Text(if(state.attempt==null)t("Submit ticket","إرسال التذكرة")else t("Retry saved submission","إعادة محاولة الإرسال المحفوظ"))}
    } else if(state.selected!=null) {
        if(customer!=null)TextButton(onClick={open(state.selected!!)},enabled=!locked){Text(t("Refresh ticket","تحديث التذكرة"))}
        state.detail?.let { detail ->
            if(state.created)Text(t("Support ticket created","تم إنشاء تذكرة الدعم"))
            Text("#${detail.ticket.number} · ${detail.ticket.subject}",style=MaterialTheme.typography.titleLarge)
            Text(label(detail.ticket.status)+" · "+label(detail.ticket.priority));Text(label(detail.ticket.category))
            Text(if(detail.ticket.status in listOf("resolved","closed"))t("Completed","مكتملة")else if(detail.ticket.status=="open")t("Awaiting first response","بانتظار الرد الأول")else t("Team is investigating","الفريق يبحث المشكلة"))
            detail.ticket.order_id?.let { id->TextButton(onClick={openOrder(id)},enabled=!locked){Text(t("Linked order","الطلب المرتبط"))} }
            detail.messages.forEach{message->Text(label(message.sender),style=MaterialTheme.typography.titleMedium);Text(CommercePresentation.dateTime(message.created_at,locale),style=MaterialTheme.typography.bodySmall);Text(message.body);HorizontalDivider()}
            if(customer!=null) {
                if(state.replied)Text(t("Reply sent","تم إرسال الرد"))
                OutlinedTextField(state.reply,{store.editReply(it)},label={Text(t("Reply","الرد"))},minLines=4,enabled=!locked && state.replyAttempt==null,modifier=Modifier.fillMaxWidth())
                if(state.replyAttempt!=null)Text(t("Reply outcome is unconfirmed. Retry the same saved reply.","نتيجة الرد غير مؤكدة. أعد محاولة الرد المحفوظ نفسه."))
                if(detail.messages.size>=100 && state.replyAttempt==null)Text(t("This ticket has reached its message limit. Open a new ticket.","بلغت التذكرة حد الرسائل. افتح تذكرة جديدة."))
                Button(onClick={shopping.act{store.sendReply()}},enabled=!locked && (state.replyAttempt?.let{it.id==state.selected} ?: (supportTextValid(state.reply,2000) && detail.messages.size<100))){Text(if(state.replyAttempt==null)t("Send reply","إرسال الرد")else t("Retry saved reply","إعادة محاولة الرد المحفوظ"))}
            } else Text(t("Keep your ticket number. Our team will use the contact details you provided.","احتفظ برقم التذكرة. سيتواصل الفريق باستخدام بيانات الاتصال التي قدمتها."))
        }
    } else if(customer!=null) {
        if(state.loaded && state.tickets.isEmpty())Text(t("No support tickets yet","لا توجد تذاكر دعم بعد"))
        state.tickets.forEach{ticket->TextButton(onClick={open(ticket.id)},enabled=!locked){Column(Modifier.fillMaxWidth()){Text("#${ticket.number} · ${ticket.subject}");Text(label(ticket.status)+" · "+label(ticket.category));Text(label(ticket.priority))}};HorizontalDivider()}
    } else TextButton(onClick=signIn,enabled=!locked){Text(t("Sign in to view your tickets","سجل الدخول لعرض تذاكرك"))}
}
