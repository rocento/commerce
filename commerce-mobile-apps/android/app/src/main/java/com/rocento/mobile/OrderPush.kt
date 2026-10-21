package com.rocento.mobile

import androidx.core.content.edit

import android.Manifest
import android.app.*
import android.content.*
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.coroutines.suspendCoroutine
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject

class StorefrontApplication : Application() {
    override fun onCreate() { super.onCreate(); OrderPush.initialize(this) }
}

/** Public Firebase client config only; server signing credentials never belong in the APK. */
object OrderPush {
    const val CHANNEL = "order_updates"
    private lateinit var context: Application
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val mutex = Mutex()
    private var client: CommerceClient? = null
    var configured by mutableStateOf(false); private set
    var enabled by mutableStateOf(false); private set
    var busy by mutableStateOf(false); private set
    var status by mutableStateOf(""); private set
    var pendingOrder by mutableStateOf<String?>(null)
    private var pendingOwner: String? = null
    private val prefs get() = context.getSharedPreferences("order.push", Context.MODE_PRIVATE)
    private fun key(owner: String) = "enabled.$owner"
    private fun id(owner: String): String = prefs.getString("id.$owner", null) ?: UUID.randomUUID().toString().also { prefs.edit { putString("id.$owner", it) } }
    fun initialize(value: Application) {
        context = value
        if (!BuildConfig.PUSH_NOTIFICATIONS) return
        try {
            val config = JSONObject(context.assets.open("google-services.json").bufferedReader().use { it.readText() })
            val clients = config.getJSONArray("client")
            val match = (0 until clients.length()).map { clients.getJSONObject(it) }.single { it.getJSONObject("client_info").getJSONObject("android_client_info").getString("package_name") == BuildConfig.APPLICATION_ID }
            val project = config.getJSONObject("project_info")
            val options = FirebaseOptions.Builder().setApplicationId(match.getJSONObject("client_info").getString("mobilesdk_app_id"))
                .setApiKey(match.getJSONArray("api_key").getJSONObject(0).getString("current_key"))
                .setProjectId(project.getString("project_id")).setGcmSenderId(project.getString("project_number")).build()
            if (FirebaseApp.getApps(context).isEmpty()) FirebaseApp.initializeApp(context, options)
            configured = true
            val owner = prefs.getString("owner", null)
            FirebaseMessaging.getInstance().isAutoInitEnabled = owner != null && prefs.getBoolean(key(owner), false)
            val manager = context.getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(NotificationChannel(CHANNEL, context.getString(R.string.order_push_channel), NotificationManager.IMPORTANCE_DEFAULT))
        } catch (_: Exception) { configured = false }
    }
    fun attach(value: CommerceClient) { client = value }
    fun allowed(): Boolean = NotificationManagerCompat.from(context).areNotificationsEnabled() &&
        (Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) &&
        context.getSystemService(NotificationManager::class.java).getNotificationChannel(CHANNEL)?.importance != NotificationManager.IMPORTANCE_NONE
    suspend fun session(owner: String?) {
        if (!::context.isInitialized) return
        if (prefs.getString("owner", null) != owner) { enabled = false; status = "" }
        prefs.edit { putString("owner", owner) }
        if (owner != null && pendingOwner != null && owner != pendingOwner) pendingOrder = null
        refresh()
    }
    suspend fun refresh() = mutex.withLock {
        if (!::context.isInitialized) return@withLock
        val owner = prefs.getString("owner", null) ?: return@withLock
        val api = client ?: return@withLock
        if (!configured) return@withLock
        busy = true
        try {
            if (!prefs.getBoolean(key(owner), false) || !allowed()) {
                enabled = false
                FirebaseMessaging.getInstance().isAutoInitEnabled = false
                api.unregisterPushDevice(id(owner))
                status = if (prefs.getBoolean(key(owner), false)) "permission" else ""
                return@withLock
            }
            FirebaseMessaging.getInstance().isAutoInitEnabled = true
            // The commerce backend still targets FCM registration tokens. FID delivery
            // requires a coordinated server migration; keep token compatibility explicit.
            @Suppress("DEPRECATION")
            val token = suspendCoroutine<String> { continuation ->
                FirebaseMessaging.getInstance().token.addOnSuccessListener { continuation.resume(it) }.addOnFailureListener { continuation.resumeWithException(it) }
            }
            api.registerPushDevice(id(owner), BuildConfig.APPLICATION_ID, token, owner)
            if (prefs.getString("owner", null) == owner && prefs.getBoolean(key(owner), false)) { enabled = true; status = "" }
            else api.unregisterPushDevice(id(owner))
        } catch (e: Exception) { if (e is CancellationException) throw e; enabled = false; status = "retry" }
        finally { busy = false }
    }
    suspend fun change(value: Boolean) {
        val owner = prefs.getString("owner", null) ?: return
        prefs.edit { putBoolean(key(owner), value) }
        if (!value) { enabled = false; context.getSystemService(NotificationManager::class.java).cancelAll() }
        refresh()
    }
    suspend fun logout() {
        if (!::context.isInitialized) return
        change(false)
        prefs.edit { remove("owner") }; enabled = false; pendingOrder = null; pendingOwner = null
    }
    fun rotated() { scope.launch { refresh() } }
    fun open(intent: Intent?) {
        val order = intent?.getStringExtra("order_push_order") ?: return
        val owner = intent.getStringExtra("order_push_owner") ?: return
        if (!validID(order) || !validID(owner)) return
        pendingOwner = owner; pendingOrder = order
    }
    fun canOpen(owner: String?) = owner != null && owner == pendingOwner
    internal fun validID(value: String) = value.matches(Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"))
    fun receive(data: Map<String, String>) {
        if (!configured || !allowed()) return
        val owner = prefs.getString("owner", null) ?: return
        val order = data["order_id"] ?: return
        val event = data["event_id"] ?: return
        if (data["customer_id"] != owner || !prefs.getBoolean(key(owner), false) || !validID(order) || !validID(event)) return
        // Bounded event deduplication; generic locally controlled lock-screen copy.
        val seen = prefs.getString("events", "")!!.split(',').filter { it.isNotEmpty() }
        if (event in seen) return
        val intent = Intent(context, MainActivity::class.java).setAction("order.$order").addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra("order_push_order", order).putExtra("order_push_owner", owner)
        val tap = PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(context, CHANNEL).setSmallIcon(R.drawable.order_push_icon)
            .setContentTitle(context.getString(R.string.order_push_title)).setContentText(context.getString(R.string.order_push_body))
            .setAutoCancel(true).setContentIntent(tap).setVisibility(NotificationCompat.VISIBILITY_PRIVATE).build()
        try {
            context.getSystemService(NotificationManager::class.java).notify(order, 1, notification)
            prefs.edit { putString("events", (seen.takeLast(99) + event).joinToString(",")) }
        } catch (_: SecurityException) { /* Permission can change between the check and delivery. */ }
    }
}
class OrderPushService : FirebaseMessagingService() {
    @Deprecated("Retained for the commerce backend FCM registration-token contract")
    override fun onNewToken(token: String) { OrderPush.rotated() }
    override fun onMessageReceived(message: RemoteMessage) { OrderPush.receive(message.data) }
}

@Composable fun OrderPushSettings(locale: String, signedIn: Boolean) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    fun t(en: String, ar: String) = if (locale == "ar") ar else en
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) scope.launch { OrderPush.change(true) }
    }
    Row {
        Text(t("Order push notifications", "إشعارات الطلبات الفورية"), Modifier.weight(1f))
        Switch(OrderPush.enabled, { value ->
            if (value && Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) permission.launch(Manifest.permission.POST_NOTIFICATIONS)
            else scope.launch { OrderPush.change(value) }
        }, enabled = OrderPush.configured && signedIn && !OrderPush.busy, modifier = Modifier.testTag("order-push-toggle"))
    }
    if (!OrderPush.configured) Text(t("Push notifications need merchant setup.", "تحتاج الإشعارات الفورية إلى إعداد المتجر."))
    else if (!signedIn) Text(t("Sign in to enable order notifications.", "سجّل الدخول لتفعيل إشعارات الطلبات."))
    else {
        TextButton(onClick = { context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)) }) { Text(t("Android notification settings", "إعدادات إشعارات Android")) }
        if (OrderPush.status == "retry") {
            Text(t("Could not sync notification settings.", "تعذرت مزامنة إعدادات الإشعارات."))
            TextButton(onClick = { scope.launch { OrderPush.refresh() } }) { Text(t("Retry", "إعادة المحاولة")) }
        }
    }
}
