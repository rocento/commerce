package com.rocento.mobile

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    override fun onNewIntent(intent: android.content.Intent) { super.onNewIntent(intent); setIntent(intent); OrderPush.open(intent) }
    override fun onResume() { super.onResume(); lifecycleScope.launch { OrderPush.refresh() } }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.light(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.light(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT),
        )
        OrderPush.open(intent)
        StorefrontIntegration.configure(intent)
        setContent { Storefront() }
    }
}

