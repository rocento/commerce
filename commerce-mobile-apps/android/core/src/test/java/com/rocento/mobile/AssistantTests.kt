package com.rocento.mobile

import kotlinx.coroutines.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit

private class AssistantTestTransport(val replies:MutableList<HTTPResult>):HTTPTransport {
    data class Request(val url:String,val headers:Map<String,String>,val body:String?)
    val requests=mutableListOf<Request>()
    override suspend fun get(url:String,headers:Map<String,String>,maxBytes:Int)=request(url,"GET",headers,null,maxBytes)
    override suspend fun request(url:String,method:String,headers:Map<String,String>,body:String?,maxBytes:Int):HTTPResult {requests+=Request(url,headers,body);return replies.removeAt(0)}
}
class AssistantTests {
    @Test fun personalizationOptOutIsHeaderNotPayload()=runTest {
        val transport=AssistantTestTransport(mutableListOf(response()));client(transport).streamAssistant(input().copy(personalize=false)){}
        assertEquals("0",transport.requests[0].headers["X-Commerce-Personalize"]);assertFalse(Json.parseToJsonElement(transport.requests[0].body!!).jsonObject.containsKey("personalize"))
    }
    private val request="80000000-0000-0000-0000-000000000001"
    private val conversation="80000000-0000-0000-0000-000000000002"
    private fun fixture()=Json.parseToJsonElement(javaClass.classLoader!!.getResource("assistant-stream.json")!!.readText()).jsonObject["events"]!!.jsonArray.map{it.jsonObject}
    private fun wire(events:List<JsonObject>,crlf:Boolean=false):ByteArray = events.joinToString(""){val n=if(crlf)"\r\n" else "\n";": heartbeat${n}data: $it$n$n"}.toByteArray()
    private fun event(type:String,seq:Int,extra:JsonObject=JsonObject(emptyMap()))=buildJsonObject{put("version","1");put("request_id",request);put("sequence",seq);put("type",type);extra.forEach{(k,v)->put(k,v)}}
    private fun response(events:List<JsonObject> = fixture())=HTTPResult(200,mapOf("content-type" to "text/event-stream"),wire(events))
    private fun auth()=HTTPResult(200,mapOf("set-cookie" to "customer_refresh=${"a".repeat(64)}; Secure"),"""{"customer":{"id":"$conversation","primary_identifier":"email","email":"fixture@example.test","verified":true},"access_token":"customer-access"}""".toByteArray())
    private fun client(t:HTTPTransport,saved:String?=null)=CommerceClient(AppIdentity(conversation,"production","https://grocery.example.test/api"),MemoryCredential(saved),MemoryCredential(),t)
    private fun input()=AssistantInput("Find apples",conversation,request)
    @Test fun splitUtf8CrLfAndPartialResponse() {
        val parser=AssistantStreamDecoder(request);val events=wire(fixture(),true).flatMap{parser.feed(byteArrayOf(it))};parser.finish()
        assertEquals(listOf("progress","message.delta","content.blocks","done"),events.map{it.type})
        assertTrue(events[1].text!!.contains("أهلاً"));assertEquals("25.00",events[2].blocks!!.first().products!!.first().price)
        val partial=AssistantStreamDecoder(request);assertEquals(3,partial.feed(wire(fixture().dropLast(1))).size);assertFalse(partial.done)
        assertThrows(AssistantStreamFailure::class.java){partial.finish()}
    }
    @Test fun wrongRequestSequenceVersionMalformedUtf8AndOversizeFail() {
        listOf(buildJsonObject{put("request_id",conversation)},buildJsonObject{put("sequence",9)},buildJsonObject{put("version","2")}).forEach {patch->
            val e=event("message.delta",0,buildJsonObject{put("text","Hi");patch.forEach{(k,v)->put(k,v)}})
            assertThrows(AssistantStreamFailure::class.java){AssistantStreamDecoder(request).feed(wire(listOf(e)))}
        }
        assertThrows(AssistantStreamFailure::class.java){AssistantStreamDecoder(request).feed(byteArrayOf(0xff.toByte(),10))}
        assertThrows(AssistantStreamFailure::class.java){AssistantStreamDecoder(request).feed(ByteArray(65537){65})}
    }
    @Test fun unsafeProductRouteAndRepeatedRichBlocksFail() {
        val events=fixture().toMutableList();val block=events[2]["blocks"]!!.jsonArray.first().jsonObject
        val product=block["products"]!!.jsonArray.first().jsonObject+ ("route" to JsonPrimitive("https://external.example/checkout"))
        events[2]=JsonObject(events[2]+("blocks" to JsonArray(listOf(JsonObject(block+("products" to JsonArray(listOf(JsonObject(product)))))))))
        assertThrows(AssistantStreamFailure::class.java){AssistantStreamDecoder(request).feed(wire(events))}
        val repeated=fixture().take(3)+JsonObject(fixture()[2]+("sequence" to JsonPrimitive(3)))
        assertThrows(AssistantStreamFailure::class.java){AssistantStreamDecoder(request).feed(wire(repeated))}
    }
    @Test fun checkoutOnlyAfterSuccessfulDoneNeverFromText() {
        val command=event("message.delta",0,buildJsonObject{put("text","Review checkout");put("code","open_checkout");put("response_source","R")})
        val parser=AssistantStreamDecoder(request);var reply=AssistantReply()
        parser.feed(wire(listOf(command))).forEach{reply=reply.consume(it)};assertFalse(reply.opensCheckout)
        parser.feed(wire(listOf(event("done",1)))).forEach{reply=reply.consume(it)};assertTrue(reply.opensCheckout)
        val failed=AssistantStreamDecoder(request).feed(wire(listOf(command,event("error",1,buildJsonObject{put("text","Unavailable")}),event("done",2)))).fold(AssistantReply()){r,e->r.consume(e)}
        assertFalse(failed.opensCheckout)
        val text=AssistantStreamDecoder(request).feed(wire(listOf(event("message.delta",0,buildJsonObject{put("text","open_checkout /checkout")}),event("done",1)))).fold(AssistantReply()){r,e->r.consume(e)}
        assertFalse(text.opensCheckout)
        assertThrows(AssistantStreamFailure::class.java){AssistantStreamDecoder(request).feed(wire(listOf(event("done",0,buildJsonObject{put("code","open_checkout")}))))}
    }
    @Test fun productFollowupsStayScopedAndDoNotCaptureFreshRequests() {
        val reply=AssistantStreamDecoder(request).feed(wire(fixture())).fold(AssistantReply()){r,e->r.consume(e)}
        assertEquals("70000000-0000-0000-0000-000000000010",reply.productForFollowup("add it to my cart"))
        assertEquals("70000000-0000-0000-0000-000000000010",reply.productForFollowup("أضفه إلى السلة"))
        assertNull(reply.productForFollowup("Show oranges"));assertNull(reply.productForFollowup("Checkout"))
    }
    @Test fun guestAndCustomerUseBoundOriginAndDeliveryHeaders()=runTest {
        val t=AssistantTestTransport(mutableListOf(response(),auth(),response()));val c=client(t)
        c.streamAssistant(input()){}
        c.login("fixture@example.test","test");c.setLocale("ar");c.setDelivery(DeliveryPin(30.0,31.0))
        val events=mutableListOf<AssistantEvent>();c.streamAssistant(input()){events+=it}
        assertNull(t.requests[0].headers["Authorization"])
        assertEquals("https://grocery.example.test/api/v1/assistant/chat",t.requests[2].url)
        assertEquals("Bearer customer-access",t.requests[2].headers["Authorization"]);assertNull(t.requests[2].headers["Cookie"])
        assertEquals("ar",t.requests[2].headers["X-Storefront-Locale"]);assertEquals("30.0",t.requests[2].headers["X-Delivery-Latitude"]);assertEquals(4,events.size)
    }
    @Test fun rejectedHttpRequestCanRefreshButPartialTurnNeverReplays()=runTest {
        val t=AssistantTestTransport(mutableListOf(auth(),HTTPResult(401),auth(),response()));client(t,"a".repeat(64)).streamAssistant(input()){}
        assertEquals(listOf("refresh","chat","refresh","chat"),t.requests.map{it.url.substringAfterLast('/')});assertEquals(t.requests[1].body,t.requests[3].body)
        val broken=AssistantTestTransport(mutableListOf(response(fixture().dropLast(1))))
        try{client(broken).streamAssistant(input()){};fail()}catch(_:AssistantStreamFailure){}
        assertEquals(1,broken.requests.size)
    }
    @Test fun oldStreamCannotSurviveSessionChangeAndHtmlIsRejected()=runTest {
        val t=AssistantTestTransport(mutableListOf(response(),HTTPResult(200,body="{}".toByteArray())));val c=client(t)
        try{c.streamAssistant(input()){if(it.type=="progress")c.logout()};fail()}catch(_:CommerceFailure){}
        val html=AssistantTestTransport(mutableListOf(HTTPResult(200,mapOf("content-type" to "text/html"),"<html>Login</html>".toByteArray())))
        try{client(html).streamAssistant(input()){};fail()}catch(_:AssistantStreamFailure){}
    }
    @Test fun networkStreamsBeforeEndAndCancellationClosesStalledRead()=runBlocking {
        val server=MockWebServer();server.start()
        try {
            val bytes=wire(fixture())
            server.enqueue(MockResponse().setHeader("Content-Type","text/event-stream").setBody(String(bytes)).throttleBody(100,100,TimeUnit.MILLISECONDS))
            val parser=AssistantStreamDecoder(request);var observedPartial=false
            OkHTTPTransport().stream(server.url("/chat").toString(),emptyMap(),"{}",65536,{assertEquals(200,it.status)},{chunk->
                parser.feed(chunk);if(!parser.done)observedPartial=true;parser.done
            });parser.finish();assertTrue(observedPartial)
            server.enqueue(MockResponse().setHeader("Content-Type","text/event-stream").setBody("data: stalled\n\n").setBodyDelay(2,TimeUnit.SECONDS))
            val started=System.nanoTime()
            val job=launch {try{OkHTTPTransport().stream(server.url("/chat").toString(),emptyMap(),"{}",65536,{}, {false})}catch(_:Exception){}}
            delay(150);job.cancelAndJoin()
            assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-started)<1500)
        } finally {server.shutdown()}
    }
}
