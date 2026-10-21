package com.rocento.mobile

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.foundation.Image
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable internal fun AccountPanel(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Surface(modifier = modifier.fillMaxWidth(), shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.background,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.onSurface.copy(alpha = .1f)), content = content)
}

@Composable internal fun AccountGuestHeader(locale: String, wishlistEnabled: Boolean, enabled: Boolean, signIn: () -> Unit, register: () -> Unit) {
    fun t(en: String, ar: String) = if (locale == "ar") ar else en
    Column(Modifier.fillMaxWidth().testTag("account-guest"), horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(18.dp)) {
        Box(Modifier.padding(top = 10.dp).size(70.dp), contentAlignment = Alignment.Center) {
            Image(painterResource(R.drawable.rocento_icon), null, Modifier.size(64.dp))
        }
        Text(t("Your everyday shop,\nmade easier.", "تسوّقك اليومي،\nبكل سهولة."),
            style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold,
            textAlign = TextAlign.Center, modifier = Modifier.semantics { heading() })
        Text(if(wishlistEnabled) t("Sign in to track orders, save favourites and check out faster.", "سجّل الدخول لتتبّع طلباتك وحفظ مفضلاتك وإتمام الشراء أسرع.")
            else t("Sign in to track orders and check out faster.", "سجّل الدخول لتتبّع طلباتك وإتمام الشراء أسرع."),
            style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Button(onClick = signIn, enabled = enabled, shape = LocalStorefrontButtonShape.current,
                modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("account-sign-in")) {
                Text(t("Sign in", "تسجيل الدخول"), fontWeight = FontWeight.SemiBold)
            }
            OutlinedButton(onClick = register, enabled = enabled, shape = LocalStorefrontButtonShape.current,
                modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("account-register")) {
                Text(t("Create account", "إنشاء حساب"), fontWeight = FontWeight.SemiBold)
            }
        }
        Row(Modifier.fillMaxWidth().padding(vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            AccountBenefit(AccountIcons.Inventory2, t("Track orders", "تتبّع الطلبات"), Modifier.weight(1f))
            if(wishlistEnabled) AccountBenefit(Icons.Outlined.FavoriteBorder, t("Save favourites", "حفظ المفضلات"), Modifier.weight(1f))
            AccountBenefit(AccountIcons.Bolt, t("Faster checkout", "شراء أسرع"), Modifier.weight(1f))
        }
    }
}

@Composable private fun AccountBenefit(icon: ImageVector, title: String, modifier: Modifier) {
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(icon, null, Modifier.size(25.dp))
        Text(title, style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center)
    }
}

@Composable internal fun AccountIdentity(customer: CustomerAccount, locale: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 14.dp).testTag("account-identity"),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        Icon(Icons.Outlined.AccountCircle, null, Modifier.size(60.dp), tint = MaterialTheme.colorScheme.primary)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(if(locale == "ar") "مرحباً بعودتك" else "Welcome back", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(customer.identifier, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(if(customer.verified) Icons.Outlined.CheckCircle else Icons.Outlined.Info, null, Modifier.size(17.dp), tint = MaterialTheme.colorScheme.primary)
                Text(if(customer.verified) { if(locale == "ar") "حساب مؤكد" else "Verified account" }
                    else { if(locale == "ar") "مطلوب تأكيد الحساب" else "Verification needed" }, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable internal fun AccountShortcut(title: String, subtitle: String, icon: ImageVector, tag: String,
    modifier: Modifier = Modifier, enabled: Boolean, onClick: () -> Unit) {
    Surface(onClick = onClick, enabled = enabled, modifier = modifier.testTag(tag), shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.background, border = BorderStroke(1.dp, MaterialTheme.colorScheme.onSurface.copy(alpha = .1f))) {
        Column(Modifier.padding(horizontal = 5.dp, vertical = 14.dp).heightIn(min = 82.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically), horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(icon, null, Modifier.size(25.dp))
            Text(title, style = MaterialTheme.typography.titleSmall, textAlign = TextAlign.Center)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
        }
    }
}

@Composable internal fun AccountOrderCard(order: CustomerOrder, locale: String, enabled: Boolean, open: () -> Unit) {
    fun t(en: String, ar: String) = if(locale == "ar") ar else en
    AccountPanel {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Icon(AccountIcons.Inventory2, null, Modifier.size(26.dp))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(t("Order", "طلب") + " #${order.number}", style = MaterialTheme.typography.titleMedium)
                    Text(CommercePresentation.status(order.status, locale), style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.primary, modifier = Modifier.testTag("order-list-status-${order.id}"))
                }
            }
            Text(CommercePresentation.dateTime(order.created_at, locale), style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("order-list-date-${order.id}"))
            HorizontalDivider(color = MaterialTheme.colorScheme.onSurface.copy(alpha = .1f))
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("${order.total} ${order.currency}", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                Button(onClick = open, enabled = enabled, shape = LocalStorefrontButtonShape.current,
                    modifier = Modifier.heightIn(min = 48.dp).testTag("account-track-${order.id}")) { Text(t("Track order", "تتبّع الطلب")) }
            }
        }
    }
}

@Composable internal fun AccountPreferences(locale: String, enabled: Boolean, language: () -> Unit,
    notifications: () -> Unit, settings: () -> Unit, help: () -> Unit, signOut: (() -> Unit)?) {
    fun t(en: String, ar: String) = if(locale == "ar") ar else en
    Column(Modifier.padding(top = 6.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text(t("PREFERENCES", "التفضيلات"), style = MaterialTheme.typography.labelMedium,
            letterSpacing = if(locale == "ar") 0.sp else 1.8.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        AccountPanel {
            Column {
                AccountPreferenceRow(t("Language", "اللغة"), AccountIcons.Language, enabled, language,
                    value = if(locale == "ar") "العربية" else "English", modifier = Modifier.testTag("account-language-row"))
                HorizontalDivider(Modifier.padding(start = 52.dp), color = MaterialTheme.colorScheme.onSurface.copy(alpha = .1f))
                AccountPreferenceRow(t("Notifications", "الإشعارات"), Icons.Outlined.Notifications, enabled, notifications)
                HorizontalDivider(Modifier.padding(start = 52.dp), color = MaterialTheme.colorScheme.onSurface.copy(alpha = .1f))
                AccountPreferenceRow(t("App settings", "إعدادات التطبيق"), Icons.Outlined.Settings, enabled, settings)
            }
        }
        Surface(onClick = help, enabled = enabled, shape = RoundedCornerShape(16.dp),
            color = MaterialTheme.colorScheme.primary.copy(alpha = .06f), modifier = Modifier.fillMaxWidth().testTag("account-help")) {
            Row(Modifier.padding(16.dp).heightIn(min = 44.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                Icon(AccountIcons.ChatBubbleOutline, null, Modifier.size(24.dp))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(t("Need a hand?", "تحتاج مساعدة؟"), style = MaterialTheme.typography.titleSmall)
                    Text(t("Help & support", "المساعدة والدعم"), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                AccountChevron()
            }
        }
        if(signOut != null) TextButton(onClick = signOut, enabled = enabled, modifier = Modifier.heightIn(min = 48.dp).testTag("account-sign-out")) {
            Icon(AccountIcons.Logout, null, Modifier.size(22.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.width(12.dp))
            Text(t("Sign out", "تسجيل الخروج"), color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable private fun AccountPreferenceRow(title: String, icon: ImageVector, enabled: Boolean, onClick: () -> Unit,
    modifier: Modifier = Modifier, value: String? = null) {
    Surface(onClick = onClick, enabled = enabled, color = MaterialTheme.colorScheme.background, modifier = modifier.fillMaxWidth()) {
        Row(Modifier.padding(16.dp).heightIn(min = 28.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            Icon(icon, null, Modifier.size(24.dp))
            Text(title, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
            if(value != null) Text(value, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            AccountChevron()
        }
    }
}

@Composable private fun AccountChevron() {
    Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight,
        null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
}

// Small native vectors use the storefront's existing 24-point outline convention.
internal object AccountIcons {
    val ShoppingBag = outline("Shopping bag") {
        moveTo(5f, 7f); lineTo(19f, 7f); lineTo(21f, 21f); lineTo(3f, 21f); close()
        moveTo(8f, 8f); lineTo(8f, 5f); curveTo(8f, 0f, 16f, 0f, 16f, 5f); lineTo(16f, 8f)
    }
    val Eco = outline("Leaf") {
        moveTo(4f, 20f); curveTo(2f, 10f, 8f, 4f, 21f, 3f); curveTo(20f, 16f, 14f, 22f, 4f, 20f)
        moveTo(4f, 20f); lineTo(15f, 9f)
    }
    val Inventory2 = outline("Order box") {
        moveTo(3f, 7f); lineTo(12f, 2f); lineTo(21f, 7f); lineTo(21f, 17f); lineTo(12f, 22f); lineTo(3f, 17f); close()
        moveTo(3f, 7f); lineTo(12f, 12f); lineTo(21f, 7f)
        moveTo(12f, 12f); lineTo(12f, 22f)
        moveTo(7.5f, 4.5f); lineTo(16.5f, 9.5f)
    }
    val Bolt = outline("Fast checkout") {
        moveTo(14f, 2f); lineTo(4f, 14f); lineTo(11f, 14f); lineTo(10f, 22f); lineTo(20f, 10f); lineTo(13f, 10f); close()
    }
    val Language = outline("Language") {
        moveTo(22f, 12f); curveTo(22f, 25.3f, 2f, 25.3f, 2f, 12f); curveTo(2f, -1.3f, 22f, -1.3f, 22f, 12f)
        moveTo(2f, 12f); lineTo(22f, 12f)
        moveTo(12f, 2f); curveTo(6f, 8f, 6f, 16f, 12f, 22f); curveTo(18f, 16f, 18f, 8f, 12f, 2f)
    }
    val ChatBubbleOutline = outline("Help") {
        moveTo(21f, 11f); curveTo(21f, 17f, 16f, 20f, 10f, 19f); lineTo(4f, 22f); lineTo(5f, 17f)
        curveTo(-2f, 10f, 4f, 2f, 12f, 2f); curveTo(18f, 2f, 21f, 6f, 21f, 11f)
    }
    val Logout = outline("Sign out") {
        moveTo(10f, 3f); lineTo(3f, 3f); lineTo(3f, 21f); lineTo(10f, 21f)
        moveTo(9f, 12f); lineTo(22f, 12f); moveTo(17f, 7f); lineTo(22f, 12f); lineTo(17f, 17f)
    }
    private fun outline(name: String, draw: androidx.compose.ui.graphics.vector.PathBuilder.() -> Unit): ImageVector =
        ImageVector.Builder(name,24.dp,24.dp,24f,24f).apply {
            path(fill=null,stroke=androidx.compose.ui.graphics.SolidColor(androidx.compose.ui.graphics.Color.Black),
                strokeLineWidth=1.7f,strokeLineCap=androidx.compose.ui.graphics.StrokeCap.Round,
                strokeLineJoin=androidx.compose.ui.graphics.StrokeJoin.Round,pathBuilder=draw)
        }.build()
}
