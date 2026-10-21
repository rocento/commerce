package com.rocento.mobile

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.UUID
import kotlinx.serialization.*
import kotlinx.serialization.json.*

@Serializable data class AssistantInput(
    val message: String, val conversation_id: String, val request_id: String = UUID.randomUUID().toString(),
    val product_id: String? = null, val cart_context: Boolean? = null, val clarification: AssistantClarification? = null,
    @Transient val personalize:Boolean=true,
)
@Serializable data class AssistantClarification(val original_message:String,val question:String,val revision:String?=null,val kind:String?=null,val choices:List<String>?=null,val optional:Boolean?=null)
@Serializable data class AssistantProduct(
    val id:String,val name:String,val image_id:String?=null,val price:String,val currency:String,
    val in_stock:Boolean?=null,val route:String,val attributes:List<Attribute>,val reasons:List<String>,val unmet:List<String>,val original_price:String?=null,
) { @Serializable data class Attribute(val name:String,val value:String) }
@Serializable data class AssistantBlock(
    val kind:String,val text:String?=null,val title:String?=null,val products:List<AssistantProduct>?=null,
    val sources:List<Source>?=null,val rows:List<ComparisonRow>?=null,val action:JsonObject?=null,val cart:JsonObject?=null,val proposal_id:String?=null,
    val product_prompt:JsonObject?=null,val cart_removal:JsonObject?=null,val cart_removal_choice:JsonObject?=null,
    val compound_choice:JsonObject?=null,
) {
    @Serializable data class Source(val kind:String,val product_id:String,val route:String)
    @Serializable data class ComparisonRow(val label:String,val values:List<String>)
    fun validate() {
        require(kind in setOf("text","product_card","product_list","comparison_table","recommendation_group","action","cart_summary","basket_proposal","saved_addresses","wishlist_manage","wishlist_transfer","product_prompt","cart_removal","cart_removal_choice","compound_choice"))
        products?.let { list ->
            require(list.size in 1..8 && list.map{it.id}.distinct().size==list.size)
            require(sources!=null && sources.size==list.size)
            list.forEachIndexed { index,p -> require(sources[index].kind=="catalog" && sources[index].product_id==p.id && sources[index].route==p.route); require(assistantUUID(p.id) && p.route=="/products/${p.id}" && p.name.isNotEmpty() && p.name.length<=1000 && p.reasons.size<=20 && p.unmet.size<=20 && p.attributes.size<=20 && (p.image_id==null || assistantUUID(p.image_id))) }
        }
        if(kind in listOf("product_card","product_list","comparison_table","recommendation_group")) require(products!=null)
        if(kind=="product_card") require(products?.size==1)
        if(kind=="comparison_table") require((products?.size ?: 0)>=2 && rows!=null && rows.size in 1..24 && rows.all{it.values.size==products?.size})
        if(kind=="basket_proposal") require(assistantUUID(proposal_id.orEmpty()))
        if(kind=="action") require(action.text("route")=="/search")
        if(kind=="cart_summary") require(cart!=null)
    }
}
@Serializable data class AssistantEvent(
    val version:String,val request_id:String,val sequence:Int,val type:String,
    val text:String?=null,val code:String?=null,val stage:String?=null,val response_source:String?=null,
    val blocks:List<AssistantBlock>?=null,val clarification:AssistantClarification?=null,val saved:Boolean?=null,
    val failure:JsonObject?=null,val order:JsonObject?=null,val ticket:JsonObject?=null,
)
fun JsonObject?.text(key:String):String? = (this?.get(key) as? JsonPrimitive)?.contentOrNull
fun JsonObject?.items(key:String):List<JsonObject> = (this?.get(key) as? JsonArray)?.mapNotNull{it as? JsonObject}.orEmpty()
fun JsonObject?.flag(key:String):Boolean = (this?.get(key) as? JsonPrimitive)?.booleanOrNull==true
fun assistantUUID(value:String):Boolean = value.matches(Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"))
class AssistantStreamFailure(message:String="The assistant returned an invalid response. Check your cart before sending again.") : Exception(message)

/** Incremental framing validates UTF-8 only after a whole line, preserving split Arabic characters. */
class AssistantStreamDecoder(private val requestID:String) {
    private val json=Json { ignoreUnknownKeys=true }
    private val line=ByteArrayOutputStream()
    private val dataLines=mutableListOf<String>()
    private var total=0
    private var sequence=0
    private var rich=false
    var done=false; private set
    fun feed(bytes:ByteArray):List<AssistantEvent> {
        try { return parse(bytes) } catch(e:Exception) { throw AssistantStreamFailure() }
    }
    private fun parse(bytes:ByteArray):List<AssistantEvent> {
        total+=bytes.size; require(total<=65536)
        val events=mutableListOf<AssistantEvent>()
        for(byte in bytes) {
            if(done) break
            if(byte.toInt()!=10) {line.write(byte.toInt());continue}
            val text=Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(line.toByteArray())).toString().removeSuffix("\r")
            line.reset()
            if(text.isEmpty()) {
                if(dataLines.isEmpty()) continue
                val payload=dataLines.joinToString("\n");dataLines.clear()
                val event=json.decodeFromString<AssistantEvent>(payload)
                require(event.version=="1" && event.request_id.equals(requestID,true) && event.sequence==sequence)
                require(event.type in listOf("progress","message.delta","content.blocks","card.order","ticket.created","error","done"))
                if(event.type in listOf("message.delta","error")) require(!event.text.isNullOrEmpty() && event.text.length<=8000)
                if(event.code=="open_checkout") require(event.type=="message.delta" && event.response_source in listOf("R","L") && event.blocks==null && event.order==null && event.ticket==null && event.failure==null && event.clarification==null && event.stage==null && event.saved==null)
                if(event.type=="progress") require(event.stage in listOf("preparing","catalog","order","support","responding"))
                event.clarification?.let { require(event.type=="message.delta" && it.original_message.length<=4000 && it.question.length<=1000 && (it.choices?.size ?: 0)<=8 && (it.kind!="shopping" || assistantUUID(it.revision.orEmpty()))) }
                if(event.type=="content.blocks") {
                    require(!rich && event.blocks!=null && event.blocks.size in 1..8 && payload.toByteArray().size<=24576 && event.text==null && event.code==null)
                    event.blocks.forEach{it.validate()};rich=true
                } else require(event.blocks==null)
                if(event.type=="card.order") require(event.order!=null)
                if(event.type=="ticket.created") require(event.ticket!=null)
                if(event.failure!=null) require(event.failure.text("request_reference").equals(requestID,true))
                require(event.saved==null || event.type=="done")
                sequence++;done=event.type=="done";events+=event
            } else if(text.startsWith("data:")) dataLines+=text.substring(5).removePrefix(" ")
        }
        return events
    }
    fun finish() {if(!done)throw AssistantStreamFailure("The response was interrupted. Check your cart before sending again.")}
}

/** Text and restored content cannot trigger checkout; only a completed successful server command can. */
data class AssistantReply(
    val text:String="",val blocks:List<AssistantBlock> = emptyList(),val clarification:AssistantClarification?=null,
    val completed:Boolean=false,val failed:Boolean=false,val needsLogin:Boolean=false,val needsAddress:Boolean=false,
    val checkoutRequested:Boolean=false,val order:JsonObject?=null,val ticket:JsonObject?=null,
) {
    val opensCheckout get()=completed && !failed && checkoutRequested
    fun productForFollowup(message:String):String? {
        val ids=blocks.flatMap{it.products.orEmpty()}.map{it.id}.distinct()
        if(ids.size!=1 || order!=null || blocks.any{it.kind in listOf("cart_summary","cart_removal")})return null
        val text=java.text.Normalizer.normalize(message,java.text.Normalizer.Form.NFKC).lowercase().trim().trimEnd('.', '!', '?', '؟')
        val pattern=Regex("""^(?:(?:please )?(?:price|availability|stock|details|how much is it|is it available|is it in stock|tell me about it|add(?: \d+)?(?: of)? (?:it|this|that)(?: to (?:my |the )?cart)?|remove (?:it|this|that)(?: from (?:my |the )?cart)?)|(?:أضفه|اضفه|أضف هذا|اضف هذا)(?: إلى السلة| للسلة)?|كم سعره|هل هو متوفر|احذفه من السلة)$""")
        return ids.first().takeIf{pattern.matches(text)}
    }
    fun consume(event:AssistantEvent):AssistantReply = when(event.type) {
        "message.delta" -> copy(text=(text+event.text.orEmpty()).take(8000),clarification=event.clarification ?: clarification,
            needsLogin=needsLogin || event.code=="login_required",needsAddress=needsAddress || event.code in listOf("area_unavailable","open_address_form"),checkoutRequested=checkoutRequested || event.code=="open_checkout")
        "content.blocks" -> copy(blocks=event.blocks.orEmpty())
        "card.order" -> copy(order=event.order)
        "ticket.created" -> copy(ticket=event.ticket)
        "error" -> copy(failed=true,needsLogin=needsLogin || event.code=="login_required" || event.failure.text("recovery")=="sign_in",text=text+(if(text.isEmpty())"" else "\n")+event.text.orEmpty())
        "done" -> copy(completed=true)
        else -> this
    }
}
