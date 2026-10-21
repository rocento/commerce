package com.rocento.mobile

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription

@Composable fun MerchantImage(url:String?,modifier:Modifier=Modifier, placeholder: @Composable () -> Unit = {}) {
    val loader = MerchantImageLoader.get(LocalContext.current)
    val bitmap by produceState<Bitmap?>(null,url) {
        value=null
        if(url!=null)try{value=loader.load(url)}catch(e:Exception){if(e is kotlinx.coroutines.CancellationException)throw e}
    }
    val image=bitmap
    if(image!=null)Image(image.asImageBitmap(),contentDescription=null,contentScale=ContentScale.Fit,modifier=modifier.testTag("merchant-image-ready"))else Box(modifier.testTag("merchant-image-loading"), contentAlignment = androidx.compose.ui.Alignment.Center) { placeholder() }
}

