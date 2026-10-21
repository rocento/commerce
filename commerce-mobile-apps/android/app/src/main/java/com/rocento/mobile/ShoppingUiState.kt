package com.rocento.mobile

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle

/** A lifecycle-owned view of immutable feature states; commands stay on ShoppingModel. */
internal data class ShoppingUiState(
    private val settingsState: AppSettingsState,
    private val accountState: AccountState,
    private val cartState: CommerceCart?,
    private val deliveryState: DeliveryFormState,
    private val ordersState: OrderState,
    private val checkoutState: CheckoutState,
    private val wishlistState: WishlistState,
    private val notificationsState: NotificationsState,
    private val navigationState: NavigationState,
    private val feedbackState: FeedbackState,
    private val loadingState: OperationLoadingState,
) {
    val notificationDetails get() = notificationsState.details
    val notificationOwner get() = notificationsState.owner
    val analyticsEnabled get() = settingsState.analyticsEnabled
    val cartPanel get() = navigationState.cartPanel
    val accountScreen get() = navigationState.panel
    val customer get() = accountState.customer
    val cart get() = cartState
    val guestAddress get() = deliveryState.guestAddress
    val locations get() = deliveryState.locations
    val orders get() = ordersState.orders
    val detail get() = ordersState.detail
    val quote get() = checkoutState.quote
    val options get() = checkoutState.options
    val windows get() = checkoutState.windows
    val uncertainCheckout get() = checkoutState.locked
    val availability get() = deliveryState.availability
    val addressDraft get() = deliveryState.addressDraft
    val selectedLocation get() = deliveryState.selectedLocation
    val method get() = deliveryState.method
    val source get() = deliveryState.source
    val date get() = deliveryState.date
    val asap get() = deliveryState.asap
    val loading get() = loadingState
    val busy get() = loadingState.busy
    val error get() = feedbackState.failure?.message
    val notice get() = feedbackState.notice
    val wishlistIDs get() = wishlistState.ids
    val wishlistProducts get() = wishlistState.products
    val wishlistLoaded get() = wishlistState.loaded
    val wishlistLimit get() = wishlistState.limit
    val wishlistResolved get() = wishlistState.resolved
    val orderDetailFailed get() = ordersState.detailFailed
    val selectedOrderID get() = ordersState.selectedID
    val ordersHasMore get() = ordersState.hasMore
    val canCheckDelivery get() = !uncertainCheckout && cart?.fully_reserved==true && cart?.items?.isNotEmpty()==true &&
        (if(method=="pickup") source.isNotEmpty() else selectedLocation.isNotEmpty()) && availability?.methods?.any{it.type==method}==true
    val canReviewCart get() = canCheckDelivery && customer?.verified==true && options?.groups?.isNotEmpty()==true &&
        (asap || options!!.groups.all { group -> windows[group.source_id]?.let { chosen -> group.slots.any { it.id==chosen.id && it.availability=="AVAILABLE" } } == true })
}

@Composable
internal fun shoppingUiState(model: ShoppingModel): ShoppingUiState {
    val settings by model.settings.state.collectAsStateWithLifecycle()
    val account by model.session.account.state.collectAsStateWithLifecycle()
    val cart by model.session.cart.state.collectAsStateWithLifecycle()
    val delivery by model.session.delivery.state.collectAsStateWithLifecycle()
    val orders by model.session.orders.state.collectAsStateWithLifecycle()
    val checkout by model.session.checkout.state.collectAsStateWithLifecycle()
    val wishlist by model.session.wishlist.state.collectAsStateWithLifecycle()
    val notifications by model.session.notifications.state.collectAsStateWithLifecycle()
    val navigation by model.session.navigation.state.collectAsStateWithLifecycle()
    val feedback by model.session.feedback.state.collectAsStateWithLifecycle()
    val loading by model.session.operations.loading.collectAsStateWithLifecycle()
    return ShoppingUiState(settings, account, cart, delivery, orders, checkout, wishlist, notifications, navigation, feedback, loading)
}
