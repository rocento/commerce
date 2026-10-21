import { useEffect, useSyncExternalStore } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { validReview, type ReviewsStore } from '../core/reviews';
import type { Customer, Locale } from '../core/commerce';
import { Button, Copy, Row } from './Storefront';

export function ReviewsPanel({ store, product, customer, locale, locked, run, signIn }: { store:ReviewsStore;product:string;customer:Customer|null;locale:Locale;locked:boolean;run:(work:()=>Promise<void>)=>Promise<void>;signIn:()=>void }) {
  const state=useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot);
  const t=(en:string,ar:string)=>locale==='ar'?ar:en;
  useEffect(()=>{void run(()=>store.open(product,!!customer));},[product,customer?.id]);
  const busy=locked||state.busy;
  const field=(key:'display_name'|'title'|'body',label:string)=><TextInput accessibilityLabel={label} placeholder={label} value={state.draft[key]} editable={!busy&&!state.uncertain} multiline={key==='body'} onChangeText={value=>store.edit({...state.draft,[key]:value})} style={{minHeight:key==='body'?110:48,borderWidth:1,borderColor:'#87968B',padding:12,textAlign:locale==='ar'?'right':'left'}} />;
  const status = (value:string) => ({pending:t('Pending approval','بانتظار الموافقة'),approved:t('Approved','تمت الموافقة'),rejected:t('Rejected','مرفوض')})[value] ?? value;
  if(state.product!==product)return null;
  return <View style={{gap:12}}>
    <Copy accessibilityRole="header" style={{fontSize:20,fontWeight:'600'}}>{t('Customer reviews','تقييمات العملاء')}</Copy>
    {state.busy&&<Copy>{t('Loading','جارٍ التحميل')}</Copy>}
    {state.failed&&<Copy accessibilityRole="alert">{t('Unable to refresh reviews','تعذر تحديث التقييمات')}</Copy>}
    {state.loaded&&!state.reviews.length&&<Copy>{t('No reviews yet','لا توجد تقييمات بعد')}</Copy>}
    {state.reviews.map(review=><View key={review.id} style={{gap:6,paddingVertical:12,borderBottomWidth:1,borderBottomColor:'#D8DED9'}}><Copy>{review.display_name} · {review.rating}/5</Copy><Copy style={{fontWeight:'600'}}>{review.title}</Copy><Copy>{review.body}</Copy></View>)}
    <Row><Button title={t('Previous reviews','التقييمات السابقة')} secondary disabled={busy||!state.offset} onPress={()=>void run(()=>store.load(!!customer,state.offset-50))}/><Button title={t('Next reviews','التقييمات التالية')} secondary disabled={busy||state.reviews.length<50} onPress={()=>void run(()=>store.load(!!customer,state.offset+50))}/></Row>
    <Button title={t('Refresh reviews','تحديث التقييمات')} secondary disabled={busy} onPress={()=>void run(()=>store.load(!!customer))}/>
    {state.submitted&&<Copy accessibilityLiveRegion="polite">{t('Review submitted for moderation','تم إرسال التقييم للمراجعة')}</Copy>}
    {state.uncertain&&<Copy accessibilityRole="alert">{t('The submission result is uncertain. Refresh reviews before retrying.','نتيجة الإرسال غير مؤكدة. حدّث التقييمات قبل إعادة المحاولة.')}</Copy>}
    {customer?.verified?<>
      <Copy style={{fontWeight:'600'}}>{state.own?t('Edit your review','تعديل تقييمك'):t('Write a review','اكتب تقييماً')}</Copy>
      {state.own&&<Copy>{status(state.own.status??'pending')}{state.own.moderation_reason?` · ${state.own.moderation_reason}`:''}</Copy>}
      <Copy>{t('Editing an approved review sends it back for approval.','تعديل التقييم المعتمد يعيده للمراجعة.')}</Copy>
      {field('display_name',t('Public display name','الاسم المعروض'))}
      <Row>{[1,2,3,4,5].map(rating=><Pressable key={rating} accessibilityRole="radio" accessibilityLabel={`${rating}/5`} accessibilityState={{checked:state.draft.rating===rating}} disabled={busy||state.uncertain} onPress={()=>store.edit({...state.draft,rating})} style={{minWidth:44,minHeight:44,justifyContent:'center',alignItems:'center'}}><Copy style={{fontSize:26,color:rating<=state.draft.rating?'#946B00':'#87968B'}}>{rating<=state.draft.rating?'★':'☆'}</Copy></Pressable>)}</Row>
      {field('title',t('Review title','عنوان التقييم'))}{field('body',t('Your review','تقييمك'))}
      {!validReview(state.draft)&&state.dirty&&<Copy>{t('Complete all fields within the limits: name 80 bytes, title 200, review 4000.','أكمل الحقول ضمن الحدود: الاسم ٨٠ بايت، العنوان ٢٠٠، والتقييم ٤٠٠٠.')}</Copy>}
      <Button title={t('Submit for moderation','إرسال للمراجعة')} disabled={busy||!state.ownLoaded||state.uncertain||!validReview(state.draft)} onPress={()=>void run(()=>store.submit(customer.verified))}/>
    </>:<Button title={customer?t('Verify your account to write a review','أكد حسابك لكتابة تقييم'):t('Sign in to write a review','سجل الدخول لكتابة تقييم')} secondary disabled={busy} onPress={signIn}/>}
  </View>;
}
