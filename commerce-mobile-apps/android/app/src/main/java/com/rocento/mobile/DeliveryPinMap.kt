package com.rocento.mobile

import android.annotation.SuppressLint
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import org.json.JSONObject

@SuppressLint("SetJavaScriptEnabled")
@Composable internal fun DeliveryPinMap(latitude:String, longitude:String, modifier:Modifier=Modifier, onPin:(Double,Double)->Unit) {
    val callback by rememberUpdatedState(onPin)
    var view by remember { mutableStateOf<WebView?>(null) }
    var ready by remember { mutableStateOf(false) }
    DisposableEffect(Unit) { onDispose { view?.removeJavascriptInterface("DeliveryMap"); view?.destroy(); view=null } }
    AndroidView(modifier=modifier,factory={context ->
        object : WebView(context) {
            override fun dispatchTouchEvent(event: android.view.MotionEvent): Boolean {
                parent?.requestDisallowInterceptTouchEvent(event.action != android.view.MotionEvent.ACTION_UP && event.action != android.view.MotionEvent.ACTION_CANCEL)
                return super.dispatchTouchEvent(event)
            }
        }.apply {
            settings.javaScriptEnabled=true
            settings.allowFileAccess=false;settings.allowContentAccess=false
            settings.userAgentString += " RocentoDelivery/1.0"
            settings.mixedContentMode=android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
            webViewClient=object:WebViewClient(){
                override fun shouldOverrideUrlLoading(v:WebView?,request:android.webkit.WebResourceRequest?)=true
            }
            addJavascriptInterface(object {
                @JavascriptInterface fun postMessage(raw:String) {
                    runCatching { val p=JSONObject(raw)
                        if(p.optString("type")=="ready") post { ready=true }
                        if(p.optString("type")=="pin") {
                            val lat=p.getDouble("latitude");val lon=p.getDouble("longitude")
                            if(lat.isFinite()&&lon.isFinite()&&kotlin.math.abs(lat)<=85&&kotlin.math.abs(lon)<=180) post { callback(lat,lon) }
                        }
                    }
                }
            },"DeliveryMap")
            loadDataWithBaseURL("https://maps.rocento.invalid/",context.assets.open("location-map.html").bufferedReader().use{it.readText()},"text/html","UTF-8",null)
            view=this
        }
    })
    LaunchedEffect(latitude,longitude,ready) {
        val lat=latitude.toDoubleOrNull();val lon=longitude.toDoubleOrNull()
        if(ready&&lat!=null&&lon!=null&&lat.isFinite()&&lon.isFinite())view?.evaluateJavascript("window.setDeliveryPin($lat,$lon);",null)
    }
}

internal suspend fun deliveryAddress(base:String, latitude:Double, longitude:Double, locale:String):String {
    val lat=String.format(java.util.Locale.US,"%.6f",latitude)
    val lon=String.format(java.util.Locale.US,"%.6f",longitude)
    val lang=if(locale=="ar")"ar" else "en"
    val result=OkHTTPTransport().get("${base.trimEnd('/')}/v1/location-address?lat=$lat&lon=$lon&lang=$lang",emptyMap(),128000)
    require(result.status==200)
    val p=org.json.JSONObject(String(result.body,Charsets.UTF_8)).getJSONArray("features").getJSONObject(0).getJSONObject("properties")
    fun value(key:String)=if(p.opt(key) is String)p.getString(key).trim() else ""
    val street=value("street").ifEmpty { value("name") }
    require(street.isNotEmpty())
    return listOf(street,value("district"),value("city"),value("state"),value("country")).filter{it.isNotEmpty()}.distinct().joinToString(", ").take(200)
}
