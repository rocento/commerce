import { useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { Platform, Pressable, ScrollView, Share, Switch, TextInput, View } from 'react-native';
import { emptyPreference, memoryOccasions, preferenceAttributes, validPreference, type AssistantLibrary, type MemoryAction } from '../core/assistantLibrary';
import type { AssistantStore } from '../core/assistantStore';
import type { Locale } from '../core/commerce';
import { Button, Copy, Row, UiContext } from './Storefront';

export function AssistantLibraryPanel({library,chat,owner,locale,locked,run,close,signIn}:{library:AssistantLibrary;chat:AssistantStore;owner?:string;locale:Locale;locked:boolean;run:(work:()=>Promise<void>)=>Promise<void>;close:()=>void;signIn:()=>void}) {
  const state=useSyncExternalStore(library.subscribe,library.getSnapshot,library.getSnapshot);
  useSyncExternalStore(chat.subscribe,chat.getSnapshot,chat.getSnapshot);
  const [search,setSearch]=useState(''),[confirm,setConfirm]=useState<MemoryAction|null>(null),[names,setNames]=useState<Record<string,string>>({});
  const {colors}=useContext(UiContext),t=(en:string,ar:string)=>locale==='ar'?ar:en;
  const label=(value:string)=>({product:t('Product','منتج'),brand:t('Brand','علامة تجارية'),color:t('Color','لون'),style:t('Style','نمط'),metal:t('Metal','معدن'),material:t('Material','خامة'),any:t('Any occasion','أي مناسبة'),everyday:t('Everyday','يومي'),gift:t('Gift','هدية'),work:t('Work','عمل'),travel:t('Travel','سفر'),self:t('Me','أنا'),other:t('Someone else','شخص آخر'),view:t('Viewed','تمت مشاهدته'),purchase:t('Purchased','تم شراؤه'),return:t('Returned','تم إرجاعه')})[value]??value;
  const busy=locked||state.busy||chat.getSnapshot().busy,writeLocked=busy||state.needsRefresh,m=state.memory,p=state.draft;
  useEffect(()=>{void run(()=>library.refresh(chat.conversationID,!!owner));return()=>library.clearExport();},[owner,chat.conversationID]);
  const mutate=(action:MemoryAction)=>void run(()=>library.mutate(action,chat.conversationID,!!owner));
  const open=(id:string)=>void run(()=>library.open(id,turns=>{chat.restoreConversation(id,turns);close();}));
  const fieldStyle={minHeight:48,borderWidth:1,borderColor:colors.border,color:colors.text,padding:12,textAlign:locale==='ar'?'right' as const:'left' as const};
  const toggle=(name:string,value:boolean,disabled:boolean,set:(value:boolean)=>void)=><Row><Copy style={{flex:1}}>{name}</Copy><Switch accessibilityLabel={name} value={value} disabled={disabled} onValueChange={set}/></Row>;
  const exportFile=async()=>{const value=library.getSnapshot().exported;if(!value)return;if(Platform.OS==='web'){const url=URL.createObjectURL(new Blob([value],{type:'application/json'}));const anchor=document.createElement('a');anchor.href=url;anchor.download='rocento-memory.json';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}else await Share.share({message:value,title:'rocento-memory.json'});};
  return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{padding:20,gap:16}}>
    <Button title={t('Back to chat','العودة للمحادثة')} secondary onPress={close}/>
    <Copy accessibilityRole="header" style={{fontSize:22,fontWeight:'600'}}>{t('Conversations & memory','المحادثات والذاكرة')}</Copy>
    {state.busy&&<Copy>{t('Loading','جارٍ التحميل')}</Copy>}
    {state.failed&&<Copy accessibilityRole="alert">{t('Unable to complete the request. Refresh to check the current state.','تعذر إكمال الطلب. حدّث للتحقق من الحالة الحالية.')}</Copy>}
    {state.changed&&<Copy accessibilityLiveRegion="polite">{t('Memory change saved','تم حفظ تغيير الذاكرة')}</Copy>}
    {state.needsRefresh&&<Copy accessibilityRole="alert">{t('Refresh before making another change. The previous change may already be saved.','حدّث قبل إجراء تغيير آخر. ربما تم حفظ التغيير السابق.')}</Copy>}
    <Button title={t('Refresh conversations & memory','تحديث المحادثات والذاكرة')} secondary disabled={busy} onPress={()=>void run(()=>library.refresh(chat.conversationID,!!owner))}/>
    <Button title={t('New conversation','محادثة جديدة')} disabled={busy} onPress={()=>{chat.reset();close();}}/>
    {toggle(t('Do not personalize this request','عدم تخصيص هذا الطلب'),!chat.personalize,busy,value=>chat.setPersonalize(!value))}
    {owner?<>
      <TextInput accessibilityLabel={t('Search conversations','البحث في المحادثات')} placeholder={t('Search conversations','البحث في المحادثات')} value={search} onChangeText={setSearch} style={fieldStyle}/>
      {!library.conversations(search).length&&state.loaded&&<Copy>{t('No matching conversations','لا توجد محادثات مطابقة')}</Copy>}
      {library.conversations(search).map(c=><Button key={c.id} title={`${c.title} · ${new Date(c.updated).toLocaleDateString(locale)}`} secondary selected={c.id===chat.conversationID} disabled={busy} onPress={()=>open(c.id)}/>)}
    </>:<Button title={t('Sign in to view conversations','سجل الدخول لعرض المحادثات')} secondary disabled={busy} onPress={signIn}/>}
    {m&&!m.enabled&&<Copy>{t('Memory is unavailable for this store','الذاكرة غير متاحة لهذا المتجر')}</Copy>}
    {m?.enabled&&<>
      <Copy accessibilityRole="header" style={{fontSize:20,fontWeight:'600'}}>{t('Memory & personalization','الذاكرة والتخصيص')}</Copy>
      <Copy>{m.guest?t('Guest catalog context expires within one hour and is not merged into an account.','تنتهي صلاحية سياق الضيف خلال ساعة ولا يُدمج في الحساب.'):t('Catalog context expires within one day. Saved goals are managed separately.','تنتهي صلاحية سياق المنتجات خلال يوم. تُدار الأهداف المحفوظة بشكل منفصل.')}</Copy>
      {toggle(t('Use my saved preferences','استخدام تفضيلاتي المحفوظة'),m.personalized,writeLocked,value=>mutate({kind:'consent',personalized:value,journey:value&&m.journey_consent,version:m.consent_version}))}
      {toggle(t('Use recent product views and purchases','استخدام المشاهدات والمشتريات الأخيرة'),m.journey_consent,writeLocked||m.guest||!m.personalized,value=>mutate({kind:'consent',personalized:m.personalized,journey:value,version:m.consent_version}))}
      {m.personalized&&<>
        <Choice title={t('Category','الفئة')} value={p.category_id} values={m.categories.map(c=>[c.id,c.name])} disabled={writeLocked} choose={category_id=>library.edit({...p,category_id})}/>
        <Choice title={t('Preference','التفضيل')} value={p.attribute} values={preferenceAttributes.map(a=>[a,label(a)])} disabled={writeLocked} choose={attribute=>library.edit({...p,attribute,value:''})}/>
        {p.attribute==='product'?<Choice title={t('Recently suggested product','منتج مقترح مؤخراً')} value={p.value} values={m.products.map(v=>[v.id,v.name])} disabled={writeLocked} choose={value=>library.edit({...p,value,category_id:m.products.find(v=>v.id===value)?.category_id??p.category_id})}/>:<TextInput accessibilityLabel={t('Preference value','قيمة التفضيل')} placeholder={t('Preference value','قيمة التفضيل')} value={p.value} onChangeText={value=>library.edit({...p,value})} editable={!writeLocked} style={fieldStyle}/>}
        <Choice title={t('For','لمن')} value={p.recipient} values={['self','other'].map(v=>[v,label(v)])} disabled={writeLocked} choose={recipient=>library.edit({...p,recipient})}/>
        <Choice title={t('Occasion','المناسبة')} value={p.occasion} values={memoryOccasions.map(v=>[v,label(v)])} disabled={writeLocked} choose={occasion=>library.edit({...p,occasion})}/>
        {toggle(t('I dislike this option','لا أفضل هذا الخيار'),p.dislike,writeLocked,dislike=>library.edit({...p,dislike}))}
        <Button title={p.replaces?t('Update preference','تحديث التفضيل'):t('Save preference','حفظ التفضيل')} disabled={writeLocked||!validPreference(p,m)} onPress={()=>mutate({kind:'preference',input:p})}/>
        {p.replaces&&<Button title={t('Cancel edit','إلغاء التعديل')} secondary disabled={writeLocked} onPress={()=>library.edit(emptyPreference())}/>}
      </>}
      <Copy style={{fontWeight:'600'}}>{t('Saved preferences','التفضيلات المحفوظة')}</Copy>
      {!m.preferences.length&&<Copy>{t('No saved preferences','لا توجد تفضيلات محفوظة')}</Copy>}
      {m.preferences.map(value=><View key={value.id} style={{gap:10,borderBottomWidth:1,borderColor:colors.border,paddingVertical:12}}><Copy>{value.signal==='explicit_dislike'?t('Dislike','لا أفضل'):t('Prefer','أفضل')} {label(value.attribute)}: {value.attribute==='product'?m.products.find(v=>v.id===value.value)?.name??t('Saved product','منتج محفوظ'):value.value} · {label(value.recipient)} · {label(value.occasion)}</Copy><Button title={t('Edit preference','تعديل التفضيل')} secondary disabled={writeLocked||!m.personalized} onPress={()=>library.editPreference(value)}/><Button title={t('Remove preference','إزالة التفضيل')} secondary disabled={writeLocked} onPress={()=>setConfirm({kind:'removePreference',id:value.id})}/></View>)}
      <Copy style={{fontWeight:'600'}}>{t('Recent signals used','الإشارات الأخيرة المستخدمة')}</Copy>
      {!m.signals.length&&<Copy>{t('No eligible recent signals','لا توجد إشارات حديثة مؤهلة')}</Copy>}
      {m.signals.map((s,i)=><Copy key={`${s.product_id}:${i}`}>{label(s.kind)} {s.name}</Copy>)}
      <Button title={t('Forget this context','نسيان هذا السياق')} secondary disabled={writeLocked} onPress={()=>setConfirm({kind:'clearContext',id:chat.conversationID})}/>
      <Button title={t('Export memory','تصدير الذاكرة')} secondary disabled={busy} onPress={()=>void run(()=>library.export())}/>
      {state.exported&&<Button title={t('Share or download JSON','مشاركة أو تنزيل JSON')} secondary disabled={busy} onPress={()=>void run(exportFile)}/>}
      <Button title={t('Delete personal memory','حذف الذاكرة الشخصية')} secondary disabled={writeLocked} onPress={()=>setConfirm({kind:'delete'})}/>
      <Copy accessibilityRole="header" style={{fontSize:20,fontWeight:'600'}}>{t('Saved goals','الأهداف المحفوظة')}</Copy>
      {!owner&&<Copy>{t('Sign in to manage saved goals','سجل الدخول لإدارة الأهداف المحفوظة')}</Copy>}
      {owner&&!state.goals.length&&<Copy>{t('No saved goals','لا توجد أهداف محفوظة')}</Copy>}
      {state.goals.map(goal=><View key={`${goal.task_id}:${goal.version}`} style={{gap:10,borderBottomWidth:1,borderColor:colors.border,paddingVertical:12}}>
        <TextInput accessibilityLabel={t('Goal name','اسم الهدف')} value={names[goal.task_id]??goal.name} onChangeText={value=>setNames({...names,[goal.task_id]:value})} editable={!writeLocked} style={fieldStyle}/>
        <Copy>{goal.archived?t('Archived','مؤرشف'):goal.state} · {t('Expires','تنتهي الصلاحية')} {new Date(goal.expires_at).toLocaleDateString(locale)}</Copy>
        <Button title={t('Continue goal','متابعة الهدف')} secondary disabled={busy||goal.archived||!(Date.parse(goal.expires_at)>Date.now())} onPress={()=>void run(()=>library.resumeGoal(goal.task_id,turns=>{chat.restoreConversation(goal.task_id,turns);close();}))}/>
        <Button title={t('Rename goal','إعادة تسمية الهدف')} secondary disabled={writeLocked||!(names[goal.task_id]??goal.name).trim()} onPress={()=>mutate({kind:'goal',goal,name:names[goal.task_id]??goal.name,archived:goal.archived})}/>
        <Button title={goal.archived?t('Unarchive goal','إلغاء أرشفة الهدف'):t('Archive goal','أرشفة الهدف')} secondary disabled={writeLocked} onPress={()=>mutate({kind:'goal',goal,name:goal.name,archived:!goal.archived})}/>
        <Button title={t('Delete goal','حذف الهدف')} secondary disabled={writeLocked} onPress={()=>setConfirm({kind:'deleteGoal',goal})}/>
      </View>)}
    </>}
    {confirm&&<View accessibilityRole="alert" style={{gap:12,borderTopWidth:1,borderColor:colors.border,paddingVertical:12}}><Copy>{confirm.kind==='delete'?t('Delete personal memory and turn personalization off? Saved goals and completed orders are separate.','حذف الذاكرة الشخصية وإيقاف التخصيص؟ الأهداف والطلبات المكتملة منفصلة.'):t('Confirm removal? Completed orders will not be deleted.','تأكيد الإزالة؟ لن تُحذف الطلبات المكتملة.')}</Copy><Button title={t('Confirm removal','تأكيد الإزالة')} disabled={writeLocked} onPress={()=>{const action=confirm;setConfirm(null);mutate(action);}}/><Button title={t('Cancel','إلغاء')} secondary onPress={()=>setConfirm(null)}/></View>}
  </ScrollView>;
}
function Choice({title,value,values,disabled,choose}:{title:string;value:string;values:string[][];disabled:boolean;choose:(value:string)=>void}){const [open,setOpen]=useState(false);return <View><Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{expanded:open}} disabled={disabled} onPress={()=>setOpen(!open)} style={{minHeight:48,justifyContent:'center'}}><Copy>{title}: {values.find(v=>v[0]===value)?.[1]??'—'} ▾</Copy></Pressable>{open&&values.map(([id,name])=><Pressable key={id} accessibilityRole="menuitem" disabled={disabled} onPress={()=>{choose(id!);setOpen(false);}} style={{minHeight:44,justifyContent:'center'}}><Copy>{name}</Copy></Pressable>)}</View>;}
