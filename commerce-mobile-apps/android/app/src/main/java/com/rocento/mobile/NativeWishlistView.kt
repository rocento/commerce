package com.rocento.mobile

import kotlinx.coroutines.flow.first

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.FavoriteBorder
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.unit.dp

@Composable fun NativeWishlistView(shopping:ShoppingModel,locale:String,openProduct:(String)->Unit,shop:()->Unit) {
    val shoppingState = shoppingUiState(shopping)
    fun t(en:String,ar:String)=if(locale=="ar")ar else en
    LaunchedEffect(locale,shoppingState.customer?.id) {
        shopping.session.operations.loading.first { !it.busy }
        shopping.loadWishlist(locale)
    }
    Column(verticalArrangement=Arrangement.spacedBy(16.dp)) {
        Text(t("Saved products","المنتجات المحفوظة"),style=MaterialTheme.typography.headlineSmall)
        if(shoppingState.error!=null) TextButton(onClick={shopping.loadWishlist(locale)},enabled=!shoppingState.busy){Text(t("Retry","إعادة المحاولة"))}
        if(shoppingState.wishlistLoaded && shoppingState.wishlistIDs.isEmpty()) {
            Text(t("Your wishlist is empty. Save a product from its details.","المفضلة فارغة. احفظ منتجاً من صفحة تفاصيله."))
            Button(shape = LocalStorefrontButtonShape.current, onClick=shop){Text(t("Explore products","استكشف المنتجات"))}
        }
        if(shoppingState.wishlistIDs.isNotEmpty()) Text("${shoppingState.wishlistIDs.size} "+t("saved products","منتجات محفوظة"))
        shoppingState.wishlistIDs.filter{it in shoppingState.wishlistResolved}.forEach { id ->
            val product=shoppingState.wishlistProducts[id]
            Column(verticalArrangement=Arrangement.spacedBy(12.dp)) {
                if(product!=null) {
                    TextButton(onClick={openProduct(id)},enabled=!shoppingState.busy,modifier=Modifier.testTag("saved-product-$id")) {
                        Row(horizontalArrangement=Arrangement.spacedBy(12.dp)) {
                            MerchantImage(product.mediaIds.firstOrNull()?.let{shopping.client.imageURL(it)},Modifier.size(80.dp))
                            Column(Modifier.weight(1f),verticalArrangement=Arrangement.spacedBy(8.dp)) { Text(product.title(locale),style=MaterialTheme.typography.titleMedium);Text("${product.price} ${product.currency}",style=MaterialTheme.typography.bodyMedium) }
                        }
                    }
                    Text(if(product.inStock)t("In stock","متوفر")else t("Out of stock","غير متوفر"))
                    Button(shape = LocalStorefrontButtonShape.current, onClick={openProduct(id)},enabled=!shoppingState.busy){Text(t("View product","عرض المنتج"))}
                } else Text(t("Product unavailable","المنتج غير متاح"))
                TextButton(onClick={shopping.removeSavedProduct(id)},enabled=!shoppingState.busy,modifier=Modifier.testTag("remove-saved-$id")){Text(t("Remove from wishlist","إزالة من المفضلة"))}
                HorizontalDivider()
            }
        }
        if(shoppingState.wishlistIDs.size>shoppingState.wishlistResolved.size) TextButton(onClick={shopping.loadWishlist(locale,true)},enabled=!shoppingState.busy){Text(t("Load more products","عرض المزيد من المنتجات"))}
    }
}
@Composable fun NativeWishlistSaveButton(shopping:ShoppingModel,product:Product,locale:String,signIn:()->Unit) {
    val shoppingState = shoppingUiState(shopping)
    val saved=product.id in shoppingState.wishlistIDs
    LaunchedEffect(product.id,shoppingState.customer?.id) {
        shopping.session.operations.loading.first { !it.busy }
        if(shoppingState.customer!=null) shopping.act { shopping.session.wishlist.refreshIDs() }
    }
    IconButton(onClick={if(shoppingState.customer==null)signIn() else shopping.saveProduct(product,!saved)},enabled=!shoppingState.busy && !shoppingState.uncertainCheckout,modifier=Modifier.testTag("save-product")) {
        Icon(if(saved) Icons.Default.Favorite else Icons.Default.FavoriteBorder,contentDescription=if(locale=="ar"){if(saved)"إزالة من المفضلة" else "حفظ في المفضلة"}else{if(saved)"Remove from wishlist" else "Save to wishlist"},modifier=Modifier.size(24.dp))
    }
    shoppingState.error?.let{Text(it,color=MaterialTheme.colorScheme.error)}
}

