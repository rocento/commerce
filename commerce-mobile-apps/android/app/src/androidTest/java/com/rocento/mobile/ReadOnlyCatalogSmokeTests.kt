package com.rocento.mobile

import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Opt-in production reads only. Never authenticates, emits telemetry or mutates a cart/order. */
class ReadOnlyCatalogSmokeTests {
    @Test fun productionCatalogAndVariantContract()=runBlocking {
        assumeTrue(InstrumentationRegistry.getArguments().getString("rocentoLiveReadOnly")=="true")
        val empty=object:CredentialStorage {override fun read():String?=null;override fun save(value:String?){error("Public catalog must not persist credentials")}}
        val identity=AppIdentity("312f9ac8-4888-4d35-92a0-e5fdb3bf59b8","production","https://grocery.rocento.com/api")
        val client=CommerceClient(identity,empty,empty)
        val categories=client.categories("en");assertTrue(categories.isNotEmpty())
        val products=client.products(null,"en");assertTrue(products.isNotEmpty())
        // Delivery geofencing is a server requirement, even for public family reads.
        val areaResponse=OkHTTPTransport().get(identity.commerceBase+"/v1/delivery-areas",emptyMap(),2000000)
        assertEquals(200,areaResponse.status)
        val areas=kotlinx.serialization.json.Json.parseToJsonElement(areaResponse.body.decodeToString()).jsonArray
        var covered:DeliveryPin?=null
        for(area in areas) {
            val a=area.jsonObject
            val candidate=DeliveryPin(a["center_lat"]!!.jsonPrimitive.double,a["center_lng"]!!.jsonPrimitive.double)
            if(client.coverage(candidate).deliverable){covered=candidate;break}
        }
        assertNotNull("Expected an active public delivery area",covered);client.setDelivery(covered)
        val parent=products.firstOrNull{it.productType=="configurable"}
        if(parent!=null) {assertTrue(client.family(parent.id).children.isNotEmpty());assertEquals(parent.id,client.product(parent.id,"en").id)}
        assertTrue(client.products("grocery-fruit","ar").isNotEmpty())
    }
}
