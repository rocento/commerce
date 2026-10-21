package com.rocento.mobile

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.core.location.LocationManagerCompat
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

@Composable internal fun AddressDialog(shopping:ShoppingModel,locale:String,dismiss:()->Unit) {
    val shoppingState = shoppingUiState(shopping)
    fun t(en:String,ar:String)=if(locale=="ar")ar else en
    val context=LocalContext.current
    val draft = shoppingState.addressDraft
    val lat = draft.latitude; val lon = draft.longitude
    val address = draft.address; val building = draft.building; val floor = draft.floor; val apartment = draft.apartment; val instructions = draft.instructions
    DisposableEffect(shopping) { onDispose { shopping.session.delivery.clearAddress() } }
    var addressStatus by remember { mutableStateOf("") }
    LaunchedEffect(lat,lon,locale,draft.locationMethod) {
        if(draft.locationMethod != "pin") return@LaunchedEffect
        val latitude=lat.toDoubleOrNull(); val longitude=lon.toDoubleOrNull()
        if(latitude!=null && longitude!=null) {
            val oldAddress=shoppingState.addressDraft.address
            addressStatus=t("Finding address…","جارٍ العثور على العنوان…")
            try {
                kotlinx.coroutines.delay(700)
                val resolved=kotlinx.coroutines.withTimeout(12000) { deliveryAddress(shopping.client.identity.commerceBase,latitude,longitude,locale) }
                kotlinx.coroutines.currentCoroutineContext().ensureActive()
                shopping.session.delivery.editAddress { if(it.latitude==lat && it.longitude==lon && it.address==oldAddress && oldAddress.isEmpty()) it.copy(address=resolved) else it }
                addressStatus=t("Review the address, then confirm your delivery location.","تحقق من العنوان ثم أكد موقع التوصيل.")
            } catch(e:Exception) {
                if(e is kotlinx.coroutines.CancellationException && e !is kotlinx.coroutines.TimeoutCancellationException) throw e
                addressStatus=t("Address lookup unavailable. Enter the address manually.","تعذر العثور على العنوان. أدخله يدوياً.")
            }
        }
    }
    var locationError by remember{mutableStateOf<String?>(null)}
    var locationRequest by remember { mutableIntStateOf(0) }
    var locationSignal by remember { mutableStateOf<android.os.CancellationSignal?>(null) }
    val locationScope = rememberCoroutineScope()
    DisposableEffect(Unit) { onDispose { locationRequest++; locationSignal?.cancel() } }

    fun locate() {
        if(shopping.session.delivery.state.value.addressDraft.locationMethod!="pin")return
        if(ContextCompat.checkSelfPermission(context,Manifest.permission.ACCESS_FINE_LOCATION)!=PackageManager.PERMISSION_GRANTED && ContextCompat.checkSelfPermission(context,Manifest.permission.ACCESS_COARSE_LOCATION)!=PackageManager.PERMISSION_GRANTED){locationError=t("Location permission is needed, or choose a pin on the map.","يلزم إذن الموقع، أو اختر موقعك على الخريطة.");return}
        val request = ++locationRequest
        locationSignal?.cancel(); val signal = android.os.CancellationSignal(); locationSignal = signal
        locationScope.launch { kotlinx.coroutines.delay(15000); if(request==locationRequest) { signal.cancel(); locationRequest++; locationError=t("Location unavailable. Choose a pin on the map.","الموقع غير متاح. اختر موقعك على الخريطة.") } }
        val manager=context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val provider=if(manager.isProviderEnabled(LocationManager.GPS_PROVIDER))LocationManager.GPS_PROVIDER else LocationManager.NETWORK_PROVIDER
        try {LocationManagerCompat.getCurrentLocation(manager,provider,signal,ContextCompat.getMainExecutor(context)){location->if(request!=locationRequest)return@getCurrentLocation;locationRequest++;if(location!=null){shopping.session.delivery.editAddress { it.copy(latitude=location.latitude.toString(),longitude=location.longitude.toString(),address="") };locationError=null}else locationError=t("Location unavailable. Choose a pin on the map.","الموقع غير متاح. اختر موقعك على الخريطة.")}}catch(e:Exception){locationError=t("Enable location or choose a pin on the map.","فعّل الموقع أو اختر موقعك على الخريطة.")}
    }
    val permission=rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()){result->if(result.values.any{it})locate()else locationError=t("Location permission was declined. You can choose a pin on the map.","تم رفض إذن الموقع. يمكنك اختيار موقعك على الخريطة.")}
    AlertDialog(onDismissRequest={if(!shoppingState.busy)dismiss()},title={Text(t("Delivery address","عنوان التوصيل"))},text={Column(Modifier.verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(10.dp)){
        shoppingState.locations.forEach { location ->
            TextButton(onClick={shopping.choose(location.id,dismiss)},enabled=!shoppingState.busy) { Text(location.formatted_address) }
        }
        Row(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
            listOf("pin" to t("Map pin","دبوس الخريطة"), "neighborhood" to t("Manual address","إدخال العنوان يدوياً")).forEach { (method,label) ->
                FilterChip(selected=draft.locationMethod==method,onClick={
                    if(draft.locationMethod==method)return@FilterChip
                    locationRequest++; locationSignal?.cancel(); locationError=null; addressStatus=""
                    shopping.session.delivery.editAddress { it.copy(locationMethod=method,geography=null,latitude="",longitude="") }
                },label={Text(label)},enabled=!shoppingState.busy)
            }
        }
        if(draft.locationMethod=="neighborhood") {
            DeliveryNeighborhood(shopping,locale)
        } else {
        Text(t("Tap the map or drag the pin to choose your delivery location.","اضغط على الخريطة أو اسحب الدبوس لاختيار موقع التوصيل."))
        DeliveryPinMap(lat,lon,Modifier.fillMaxWidth().height(300.dp)) { latitude,longitude ->
            locationRequest++; locationSignal?.cancel()
            shopping.session.delivery.editAddress { it.copy(latitude=latitude.toString(),longitude=longitude.toString(),address="") };locationError=null
        }
        TextButton(onClick={if(ContextCompat.checkSelfPermission(context,Manifest.permission.ACCESS_FINE_LOCATION)==PackageManager.PERMISSION_GRANTED)locate()else permission.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION,Manifest.permission.ACCESS_COARSE_LOCATION))}){Text(t("Use current location","استخدام الموقع الحالي"))}
        locationError?.let{Text(it)}
        if(addressStatus.isNotEmpty()) Text(addressStatus)
        }
        OutlinedTextField(address,{ value -> shopping.session.delivery.editAddress { it.copy(address=value) } },label={Text(t("Street and address","الشارع والعنوان"))});OutlinedTextField(building,{ value -> shopping.session.delivery.editAddress { it.copy(building=value) } },label={Text(t("Building","المبنى"))})
        OutlinedTextField(floor,{ value -> shopping.session.delivery.editAddress { it.copy(floor=value) } },label={Text(t("Floor","الطابق"))});OutlinedTextField(apartment,{ value -> shopping.session.delivery.editAddress { it.copy(apartment=value) } },label={Text(t("Apartment","الشقة"))});OutlinedTextField(instructions,{ value -> shopping.session.delivery.editAddress { it.copy(instructions=value) } },label={Text(t("Delivery instructions","تعليمات التوصيل"))})
        shoppingState.error?.let{Text(it,color=MaterialTheme.colorScheme.error)}
    }},confirmButton={TextButton(onClick={val pin=runCatching{DeliveryPin(lat.toDouble(),lon.toDouble())}.getOrNull();if(pin!=null)shopping.save(pin,address,building,floor,apartment,instructions,dismiss)else locationError=t("Choose a valid pin","اختر موقعاً صحيحاً")},enabled=!shoppingState.busy&&address.isNotBlank()&&lat.toDoubleOrNull()!=null&&lon.toDoubleOrNull()!=null){Text(if(shoppingState.customer==null)t("Use this location","استخدم هذا الموقع") else t("Save address","حفظ العنوان"))}},dismissButton={TextButton(onClick=dismiss,enabled=!shoppingState.busy){Text(t("Cancel","إلغاء"))}})
}

@Composable private fun DeliveryNeighborhood(shopping:ShoppingModel,locale:String) {
    fun t(en:String,ar:String)=if(locale=="ar")ar else en
    val draft=shoppingUiState(shopping).addressDraft
    var country by remember { mutableStateOf("") }
    var region by remember { mutableStateOf("") }
    var regions by remember { mutableStateOf(listOf<org.json.JSONObject>()) }
    var cities by remember { mutableStateOf(listOf<org.json.JSONObject>()) }
    var search by remember { mutableStateOf("") }
    var choosingCity by remember { mutableStateOf(true) }
    var loading by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    var retry by remember { mutableIntStateOf(0) }
    fun clear() { shopping.session.delivery.editAddress { it.copy(latitude="",longitude="",geography=null) } }
    val countries=listOf(Triple("EG","Egypt","مصر"),Triple("SA","Saudi Arabia","السعودية"),Triple("KW","Kuwait","الكويت"),Triple("US","United States","الولايات المتحدة"),Triple("NL","Netherlands","هولندا"),Triple("GB","United Kingdom","المملكة المتحدة"))
    DeliveryChoice(t("Country","الدولة"),countries.map { it.first to if(locale=="ar")it.third else it.second },country) {
        if(country==it)return@DeliveryChoice
        choosingCity=true;country=it;region="";regions=emptyList();cities=emptyList();search="";clear()
    }
    DeliveryChoice(t("Region","المنطقة"),regions.map { it.getString("code") to (if(locale=="ar")it.optString("name_ar").ifEmpty{it.getString("name")} else it.getString("name")) },region) {
        if(region==it)return@DeliveryChoice
        choosingCity=true;region=it;cities=emptyList();search="";clear()
    }
    OutlinedTextField(search,{search=it;choosingCity=true},label={Text(t("Search city or neighborhood","ابحث عن المدينة أو الحي"))},enabled=cities.isNotEmpty())
    if(loading) CircularProgressIndicator()
    if(failed) { Text(t("Location list unavailable.","قائمة المواقع غير متاحة."));TextButton(onClick={retry++}){Text(t("Retry","إعادة المحاولة"))} }
    draft.geography?.get("city_name")?.let { TextButton(onClick={choosingCity=true}) { Text(it,style=MaterialTheme.typography.titleSmall) } }
    if(choosingCity) cities.filter { search.isBlank() || it.getString("name").contains(search,true) || it.getJSONArray("aliases").toString().contains(search,true) }.take(60).forEach { city ->
        TextButton(onClick={
            val state=regions.firstOrNull{it.getString("code")==region} ?: return@TextButton
            val pin=runCatching { DeliveryPin(city.getDouble("latitude"),city.getDouble("longitude")) }.getOrNull() ?: return@TextButton
            choosingCity=false
            shopping.session.delivery.editAddress { it.copy(latitude=pin.latitude.toString(),longitude=pin.longitude.toString(),geography=mapOf("country_code" to country,"state_code" to region,"state_name" to state.getString("name"),"city_id" to city.getString("id"),"city_name" to city.getString("name"))) }
        }) { Text(city.getString("name")) }
    }
    Text(t("No pin needed. Choose your area, then enter your street and building below.","لا يلزم دبوس. اختر منطقتك ثم أدخل الشارع والمبنى أدناه."),style=MaterialTheme.typography.bodySmall)
    Text("GeoNames · CC BY 4.0",style=MaterialTheme.typography.labelSmall)
    LaunchedEffect(country,region,retry) {
        if(country.isEmpty())return@LaunchedEffect
        loading=true;failed=false
        try {
            val base=java.net.URI(shopping.client.identity.commerceBase).resolve("/data/delivery/${country.lowercase()}/${region.ifEmpty{"index"}}.json").toString()
            val result=OkHTTPTransport().get(base,emptyMap(),8000000)
            require(result.status==200)
            val raw=String(result.body,Charsets.UTF_8)
            val array=if(region.isEmpty())org.json.JSONObject(raw).getJSONArray("states") else org.json.JSONArray(raw)
            val items=(0 until array.length()).map{array.getJSONObject(it)}
            kotlinx.coroutines.currentCoroutineContext().ensureActive()
            if(region.isEmpty()) { require(items.all { it.getString("code").matches(Regex("[A-Z0-9]{1,12}")) });regions=items } else cities=items
            loading=false
        } catch(e:Exception) { if(e is kotlinx.coroutines.CancellationException)throw e;failed=true;loading=false }
    }
}

@Composable private fun DeliveryChoice(label:String,options:List<Pair<String,String>>,selected:String,onSelect:(String)->Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        OutlinedButton(onClick={expanded=true},enabled=options.isNotEmpty()) { Text("$label: ${options.firstOrNull{it.first==selected}?.second ?: "—"}") }
        DropdownMenu(expanded=expanded,onDismissRequest={expanded=false}) {
            options.forEach { (id,name) -> DropdownMenuItem(text={Text(name)},onClick={expanded=false;onSelect(id)}) }
        }
    }
}
