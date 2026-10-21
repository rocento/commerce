import { View } from 'react-native';
import type { Locale, OrderDetail } from '../core/commerce';
import { Copy } from './Storefront';

export function OrderContents({ detail, locale }: {detail:OrderDetail;locale:Locale}) {
  const t=(en:string,ar:string)=>locale==='ar'?ar:en;
  const order=detail.order;
  const amount=(label:string,value:string|undefined)=>value!==undefined?<Copy>{label}: {value} {order.currency}</Copy>:null;
  return <View style={{gap:12}}>
    {!!order.gift_message&&<Copy>{t('Gift message','رسالة الهدية')}: {order.gift_message}</Copy>}
    {!!detail.items?.length&&<Copy accessibilityRole="header" style={{fontSize:18,fontWeight:'600'}}>{t('Your items','منتجاتك')}</Copy>}
    {detail.items?.map(item=><View key={item.product_id} style={{gap:4,paddingVertical:8,borderBottomWidth:1,borderBottomColor:'#D8DED9'}}><Copy style={{fontWeight:'600'}}>{item.name}</Copy><Copy>{item.quantity} × {item.price} {order.currency}{item.unit?` · ${item.unit}`:''}</Copy>{amount(t('Line subtotal','المجموع الفرعي للمنتج'),item.line_total)}{amount(t('Line discount','خصم المنتج'),item.discount_amount)}</View>)}
    {amount(t('Subtotal','المجموع الفرعي'),order.subtotal)}{amount(t('Discount','الخصم'),order.discount_amount)}{amount(t('Delivery','التوصيل'),order.delivery_fee)}{amount(t('Tax','الضريبة'),order.tax_amount)}
  </View>;
}
