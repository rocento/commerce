package com.rocento.mobile

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp

@Composable fun OrderContentsView(detail:CustomerOrderDetail,locale:String) {
    fun t(en:String,ar:String)=if(locale=="ar")ar else en
    Column(verticalArrangement=Arrangement.spacedBy(12.dp)) {
        detail.order.gift_message?.takeIf{it.isNotEmpty()}?.let{Text(t("Gift message: ","رسالة الهدية: ")+it)}
        if(!detail.items.isNullOrEmpty())Text(t("Your items","منتجاتك"),style=MaterialTheme.typography.titleMedium)
        detail.items.orEmpty().forEach { item -> Column(verticalArrangement=Arrangement.spacedBy(4.dp)) {
            Text(item.name,style=MaterialTheme.typography.titleMedium)
            Text("${item.quantity} × ${item.price} ${detail.order.currency}"+(item.unit?.let{" · $it"} ?: ""))
            Text(t("Line subtotal: ","المجموع الفرعي للمنتج: ")+item.line_total+" "+detail.order.currency)
            item.discount_amount?.let{Text(t("Line discount: ","خصم المنتج: ")+it+" "+detail.order.currency)}
            HorizontalDivider()
        } }
        listOf(t("Subtotal","المجموع الفرعي") to detail.order.subtotal,t("Discount","الخصم") to detail.order.discount_amount,t("Delivery","التوصيل") to detail.order.delivery_fee,t("Tax","الضريبة") to detail.order.tax_amount).forEach{(label,value)->if(value!=null)Text("$label: $value ${detail.order.currency}")}
    }
}
