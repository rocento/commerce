package com.rocento.mobile

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@Composable fun ReviewsView(shopping:ShoppingModel,product:String,locale:String,signIn:()->Unit) {
    val shoppingState = shoppingUiState(shopping)
    val store=shopping.session.reviews;val state by store.state.collectAsStateWithLifecycle()
    val customer=shoppingState.customer
    LaunchedEffect(product,customer?.id){shopping.session.perform(OperationKind.Refresh,locale){store.open(product,customer!=null)}}
    fun t(en:String,ar:String)=if(locale=="ar")ar else en
    val locked=shoppingState.busy || shoppingState.uncertainCheckout || state.busy
    fun refresh(offset:Int=state.offset){shopping.act { store.load(shoppingState.customer!=null,offset) }}
    if(state.product==product)Column(verticalArrangement=Arrangement.spacedBy(12.dp)) {
        Text(t("Customer reviews","تقييمات العملاء"),style=MaterialTheme.typography.titleLarge)
        shoppingState.error?.let { Text(it,color=MaterialTheme.colorScheme.error) }
        if(state.busy)LinearProgressIndicator(Modifier.fillMaxWidth())
        if(state.failed)Text(t("Unable to refresh reviews","تعذر تحديث التقييمات"),color=MaterialTheme.colorScheme.error)
        if(state.loaded && state.reviews.isEmpty())Text(t("No reviews yet","لا توجد تقييمات بعد"))
        state.reviews.forEach { review -> Column(verticalArrangement=Arrangement.spacedBy(6.dp)) {
            Text("${review.display_name} · ${review.rating}/5");Text(review.title,style=MaterialTheme.typography.titleMedium);Text(review.body);HorizontalDivider()
        } }
        Row {
            TextButton(onClick={refresh((state.offset-50).coerceAtLeast(0))},enabled=!locked && state.offset>0,modifier=Modifier.weight(1f)){Text(t("Previous reviews","التقييمات السابقة"))}
            TextButton(onClick={refresh(state.offset+50)},enabled=!locked && state.reviews.size>=50,modifier=Modifier.weight(1f)){Text(t("Next reviews","التقييمات التالية"))}
        }
        TextButton(onClick={refresh()},enabled=!locked){Text(t("Refresh reviews","تحديث التقييمات"))}
        if(state.submitted)Text(t("Review submitted for moderation","تم إرسال التقييم للمراجعة"))
        if(state.uncertain)Text(t("The submission result is uncertain. Refresh reviews before retrying.","نتيجة الإرسال غير مؤكدة. حدّث التقييمات قبل إعادة المحاولة."))
        if(customer?.verified==true) {
            Text(if(state.own==null)t("Write a review","اكتب تقييماً")else t("Edit your review","تعديل تقييمك"),style=MaterialTheme.typography.titleMedium)
            state.own?.let { review ->
                Text(mapOf("pending" to t("Pending approval","بانتظار الموافقة"),"approved" to t("Approved","تمت الموافقة"),"rejected" to t("Rejected","مرفوض"))[review.status] ?: review.status.orEmpty())
                review.moderation_reason?.let { Text(it) }
            }
            Text(t("Editing an approved review sends it back for approval.","تعديل التقييم المعتمد يعيده للمراجعة."),style=MaterialTheme.typography.bodySmall)
            OutlinedTextField(state.draft.display_name,{store.edit(state.draft.copy(display_name=it))},label={Text(t("Public display name","الاسم المعروض"))},enabled=!locked && !state.uncertain,modifier=Modifier.fillMaxWidth())
            Row { (1..5).forEach { rating -> Column(Modifier.weight(1f)) {
                RadioButton(state.draft.rating==rating,{store.edit(state.draft.copy(rating=rating))},enabled=!locked && !state.uncertain)
                Text("$rating/5")
            } } }
            OutlinedTextField(state.draft.title,{store.edit(state.draft.copy(title=it))},label={Text(t("Review title","عنوان التقييم"))},enabled=!locked && !state.uncertain,modifier=Modifier.fillMaxWidth())
            OutlinedTextField(state.draft.body,{store.edit(state.draft.copy(body=it))},label={Text(t("Your review","تقييمك"))},minLines=4,enabled=!locked && !state.uncertain,modifier=Modifier.fillMaxWidth())
            if(state.dirty && !state.draft.valid)Text(t("Complete all fields within the limits: name 80 bytes, title 200, review 4000.","أكمل الحقول ضمن الحدود: الاسم ٨٠ بايت، العنوان ٢٠٠، والتقييم ٤٠٠٠."),style=MaterialTheme.typography.bodySmall)
            Button(onClick={shopping.act { store.submit(shoppingState.customer?.verified==true) }},enabled=!locked && state.ownLoaded && !state.uncertain && state.draft.valid){Text(t("Submit for moderation","إرسال للمراجعة"))}
        } else TextButton(onClick=signIn,enabled=!locked){Text(if(customer==null)t("Sign in to write a review","سجل الدخول لكتابة تقييم")else t("Verify your account to write a review","أكد حسابك لكتابة تقييم"))}
    }
}
