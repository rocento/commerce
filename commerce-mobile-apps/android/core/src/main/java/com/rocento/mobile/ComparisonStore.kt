package com.rocento.mobile

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*

data class ComparisonState(val ids:List<String> = emptyList(),val products:List<Product> = emptyList(),val failed:List<String> = emptyList(),val busy:Boolean=false)
data class ComparisonRow(val label:String,val values:List<String>)
class ComparisonStore {
    private val mutableState=MutableStateFlow(ComparisonState())
    val state=mutableState.asStateFlow()
    var onChange:(()->Unit)?=null
    private var generation=0
    private fun publish(value:ComparisonState){mutableState.value=value;onChange?.invoke()}
    fun reset(){generation++;publish(ComparisonState())}
    fun toggle(value:String){
        if(!assistantUUID(value))return
        val id=value.lowercase();val ids=state.value.ids
        generation++;publish(ComparisonState(ids=if(id in ids)ids-id else if(ids.size<5)ids+id else ids))
    }
    val prompt get()=if(state.value.ids.size<2)"" else "Compare these products: "+state.value.ids.joinToString(" "){"/products/$it"}
    suspend fun load(fetch:suspend (String)->Product){
        val revision=++generation;val ids=state.value.ids;publish(ComparisonState(ids=ids,busy=true))
        val products=mutableListOf<Product>();val failed=mutableListOf<String>()
        try { for(id in ids){
            try {val value=fetch(id);currentCoroutineContext().ensureActive();if(value.id==id && value.active!=false)products.add(value) else failed.add(id)}
            catch(e:CancellationException){throw e}
            catch(_:Exception){failed.add(id)}
            if(revision!=generation)return
        };publish(ComparisonState(ids,products,failed,false)) }
        finally {if(revision==generation)publish(state.value.copy(busy=false))}
    }
    companion object {
        fun value(value:JsonElement?,locale:String):String {
            val primitive=value as? JsonPrimitive
            if(primitive!=null && primitive !is JsonNull){
                if(primitive.isString && primitive.content.isNotBlank())return primitive.content
                primitive.booleanOrNull?.let{return if(locale=="ar")if(it)"نعم" else "لا" else if(it)"Yes" else "No"}
                primitive.doubleOrNull?.takeIf{it.isFinite()}?.let{return primitive.content}
            }
            return if(locale=="ar")"غير متوفر" else "Not provided"
        }
    }
    fun rows(locale:String):List<ComparisonRow> {
        fun t(en:String,ar:String)=if(locale=="ar")ar else en
        val products=state.value.products
        return listOf(
            ComparisonRow(t("Price","السعر"),products.map{if(it.productType=="simple")"${it.displayPrice} ${it.currency}" else t("Choose options for pricing","اختر الخيارات لمعرفة السعر")}),
            ComparisonRow(t("Selling unit","وحدة البيع"),products.map{value(it.unit?.let(::JsonPrimitive),locale)}),
            ComparisonRow(t("Availability","التوفر"),products.map{if(it.productType!="simple")t("Choose options to check availability","اختر الخيارات للتحقق من التوفر") else if(it.inStock)t("In stock","متوفر") else t("Out of stock","غير متوفر")}),
            ComparisonRow(t("Description","الوصف"),products.map{value(JsonPrimitive(it.description),locale)})
        )+products.flatMap{it.attributes?.keys.orEmpty()}.distinct().sorted().map{key->ComparisonRow(key.replace('_',' ').replace('-',' '),products.map{value(it.attributes?.get(key),locale)})}
    }
}
