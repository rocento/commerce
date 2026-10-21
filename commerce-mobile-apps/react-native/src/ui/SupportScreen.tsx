import { useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { supportCategories, supportTextValid, validSupport, type SupportDraft, type SupportStore } from '../core/support';
import type { Locale } from '../core/commerce';
import { Button, Copy, UiContext } from './Storefront';

export function SupportScreen({store,owner,locale,locked,run,signIn,openOrder}:{store:SupportStore;owner?:string;locale:Locale;locked:boolean;run:(work:()=>Promise<void>)=>Promise<void>;signIn:()=>void;openOrder:(id:string)=>void}) {
  const state=useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot);
  const {colors}=useContext(UiContext),[categoriesOpen,setCategoriesOpen]=useState(false);
  const t=(en:string,ar:string)=>locale==='ar'?ar:en;
  const label=(value:string)=>({order_issue:t('Order issue','مشكلة في الطلب'),product_question:t('Product question','سؤال عن منتج'),complaint:t('Complaint','شكوى'),payment_dispute:t('Payment dispute','نزاع دفع'),other:t('Other','أخرى'),open:t('Open','مفتوحة'),in_progress:t('In progress','قيد المعالجة'),resolved:t('Resolved','تم الحل'),closed:t('Closed','مغلقة'),high:t('High priority','أولوية عالية'),normal:t('Normal priority','أولوية عادية'),customer:t('Customer','العميل'),admin:t('Support team','فريق الدعم')})[value]??value;
  const busy=locked||state.busy,detail=state.detail;
  useEffect(()=>{if(owner)void run(()=>store.refresh());},[owner]);
  const style={minHeight:48,padding:12,borderWidth:1,borderColor:colors.border,color:colors.text,textAlign:locale==='ar'?'right' as const:'left' as const};
  const field=(key:keyof SupportDraft,name:string,multiline=false)=><TextInput accessibilityLabel={name} placeholder={name} value={state.draft[key]??''} onChangeText={value=>store.edit({...state.draft,[key]:value})} editable={!busy&&!state.attempt} multiline={multiline} style={[style,multiline&&{minHeight:120}]}/>;
  return <View style={{gap:14}}>
    {state.busy&&<Copy>{t('Loading','جارٍ التحميل')}</Copy>}
    {state.failed&&<Copy accessibilityRole="alert">{t('The request could not be completed. Your draft is retained.','تعذر إكمال الطلب. تم الاحتفاظ بالمسودة.')}</Copy>}
    <Button title={t('Your tickets','تذاكرك')} secondary disabled={busy} onPress={()=>{store.showList();if(owner)void run(()=>store.refresh());}}/>
    <Button title={state.attempt?t('Resume saved submission','متابعة الإرسال المحفوظ'):t('Open a ticket','فتح تذكرة')} secondary disabled={busy} onPress={()=>store.compose()}/>
    {!!state.replyAttempt&&state.replyAttempt.id!==state.selected&&<Button title={t('Return to pending reply','العودة للرد المعلق')} secondary disabled={busy} onPress={()=>void run(()=>store.open(state.replyAttempt!.id))}/>}
    {state.composing?<>
      {state.draft.order_id&&<><Button title={t('Linked order','الطلب المرتبط')} secondary disabled={busy} onPress={()=>openOrder(state.draft.order_id!)}/><Button title={t('Remove linked order','إزالة الطلب المرتبط')} secondary disabled={busy||!!state.attempt} onPress={()=>store.edit({...state.draft,order_id:undefined})}/></>}
      {field('subject',t('Subject','الموضوع'))}
      <Pressable accessibilityRole="button" accessibilityLabel={t('Category','الفئة')} accessibilityState={{expanded:categoriesOpen}} disabled={busy||!!state.attempt} onPress={()=>setCategoriesOpen(!categoriesOpen)} style={{minHeight:48,justifyContent:'center',borderBottomWidth:1,borderColor:colors.border}}><Copy>{t('Category','الفئة')}: {label(state.draft.category)} ▾</Copy></Pressable>
      {categoriesOpen&&supportCategories.map(category=><Pressable key={category} accessibilityRole="menuitem" disabled={busy||!!state.attempt} onPress={()=>{store.edit({...state.draft,category});setCategoriesOpen(false);}} style={{minHeight:44,justifyContent:'center'}}><Copy>{label(category)}</Copy></Pressable>)}
      {field('body',t('Message','الرسالة'),true)}
      {!owner&&<>{field('contact_name',t('Your name','اسمك'))}{field('contact',t('Email or mobile number','البريد الإلكتروني أو رقم الهاتف'))}</>}
      <Copy>{t('Subject: 160 bytes maximum. Message: 2000 bytes maximum.','الموضوع: ١٦٠ بايت كحد أقصى. الرسالة: ٢٠٠٠ بايت كحد أقصى.')}</Copy>
      {state.attempt&&<Copy accessibilityRole="alert">{t('The result is unconfirmed. Retry the same saved submission.','النتيجة غير مؤكدة. أعد محاولة الإرسال المحفوظ نفسه.')}</Copy>}
      <Button title={state.attempt?t('Retry saved submission','إعادة محاولة الإرسال المحفوظ'):t('Submit ticket','إرسال التذكرة')} disabled={busy||(!state.attempt&&!validSupport(state.draft,!!owner))} onPress={()=>void run(()=>store.create(!!owner))}/>
    </>:state.selected?<>
      {owner&&<Button title={t('Refresh ticket','تحديث التذكرة')} secondary disabled={busy} onPress={()=>void run(()=>store.open(state.selected!))}/>}
      {detail&&<>
        {state.created&&<Copy accessibilityLiveRegion="polite">{t('Support ticket created','تم إنشاء تذكرة الدعم')}</Copy>}
        <Copy style={{fontSize:20,fontWeight:'600'}}>#{detail.ticket.number} · {detail.ticket.subject}</Copy>
        <Copy>{label(detail.ticket.status)} · {label(detail.ticket.priority)} · {label(detail.ticket.category)}</Copy>
        <Copy>{['resolved','closed'].includes(detail.ticket.status)?t('Completed','مكتملة'):detail.ticket.status==='open'?t('Awaiting first response','بانتظار الرد الأول'):t('Team is investigating','الفريق يبحث المشكلة')}</Copy>
        {detail.ticket.order_id&&<Button title={t('Linked order','الطلب المرتبط')} secondary disabled={busy} onPress={()=>openOrder(detail.ticket.order_id!)}/>}
        {detail.messages.map(message=><View key={message.id} style={{gap:6,borderBottomWidth:1,borderColor:colors.border,paddingVertical:12}}><Copy style={{fontWeight:'600'}}>{label(message.sender)}</Copy><Copy>{new Date(message.created_at).toLocaleString(locale)}</Copy><Copy testID={`support-message-${message.id}`}>{message.body}</Copy></View>)}
        {owner?<>
          {state.replied&&<Copy accessibilityLiveRegion="polite">{t('Reply sent','تم إرسال الرد')}</Copy>}
          <TextInput accessibilityLabel={t('Reply','الرد')} placeholder={t('Reply','الرد')} value={state.reply} onChangeText={value=>store.editReply(value)} editable={!busy&&!state.replyAttempt} multiline style={[style,{minHeight:120}]}/>
          {state.replyAttempt&&<Copy accessibilityRole="alert">{t('Reply outcome is unconfirmed. Retry the same saved reply.','نتيجة الرد غير مؤكدة. أعد محاولة الرد المحفوظ نفسه.')}</Copy>}
          {detail.messages.length>=100&&!state.replyAttempt&&<Copy>{t('This ticket has reached its message limit. Open a new ticket.','بلغت التذكرة حد الرسائل. افتح تذكرة جديدة.')}</Copy>}
          <Button title={state.replyAttempt?t('Retry saved reply','إعادة محاولة الرد المحفوظ'):t('Send reply','إرسال الرد')} disabled={busy||(state.replyAttempt?state.replyAttempt.id!==state.selected:!supportTextValid(state.reply,2000)||detail.messages.length>=100)} onPress={()=>void run(()=>store.sendReply())}/>
        </>:<Copy>{t('Keep your ticket number. Our team will use the contact details you provided.','احتفظ برقم التذكرة. سيتواصل الفريق باستخدام بيانات الاتصال التي قدمتها.')}</Copy>}
      </>}
    </>:owner?<>
      {state.loaded&&!state.tickets.length&&<Copy>{t('No support tickets yet','لا توجد تذاكر دعم بعد')}</Copy>}
      {state.tickets.map(ticket=><Button key={ticket.id} title={`#${ticket.number} · ${ticket.subject} · ${label(ticket.status)}`} secondary disabled={busy} onPress={()=>void run(()=>store.open(ticket.id))}/>)}
    </>:<Button title={t('Sign in to view your tickets','سجل الدخول لعرض تذاكرك')} secondary disabled={busy} onPress={signIn}/>}
  </View>;
}
