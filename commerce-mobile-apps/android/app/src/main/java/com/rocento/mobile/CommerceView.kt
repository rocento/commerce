package com.rocento.mobile

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

@Composable fun CommerceView(shopping:ShoppingModel,locale:String,tab:String,wishlistEnabled:Boolean=false,openProduct:(String)->Unit={},openWishlist:()->Unit={},shop:()->Unit={},toggleLanguage:()->Unit={},openHelp:()->Unit={}) {
    val shoppingState = shoppingUiState(shopping)
    fun t(en:String,ar:String)=if(locale=="ar")ar else en
    if(tab=="account") {
        Column {
            NativeAccountScreen(shopping,locale,wishlistEnabled,openWishlist,shop,toggleLanguage,openHelp)
        }
        return
    }
    var addingAddress by remember{mutableStateOf(false)}
    LaunchedEffect(shopping,locale){shopping.client.setLocale(locale);shopping.load()}
    if(tab=="cart") {
        NativeCartScreen(shopping,locale,wishlistEnabled,openProduct,openWishlist,shop,openHelp)
        return
    }
    Column(verticalArrangement=Arrangement.spacedBy(16.dp)) {
        if(shoppingState.busy) LinearProgressIndicator(Modifier.fillMaxWidth().semantics { contentDescription=shoppingState.loading.label(locale) })
        shoppingState.error?.let{Text(it,color=MaterialTheme.colorScheme.error,modifier=Modifier.testTag("commerce-error"))}
        shoppingState.notice?.let{Text(it,modifier=Modifier.testTag("commerce-notice"))}
        val customer=shoppingState.customer
        if(customer==null) {
            AccountSignIn(shopping,locale)
        } else if(tab=="wishlist") {
            NativeWishlistView(shopping,locale,openProduct,shop)

        }
    }
    if(addingAddress)AddressDialog(shopping,locale){addingAddress=false}
}
