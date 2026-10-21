package com.rocento.mobile

class ShoppingSession(private val client: CommerceClient, notificationPreferences: NotificationPreferences = MemoryNotificationPreferences()) {
    val checkout = CheckoutFlow()
    val feedback = FeedbackStore()
    val operations = OperationCoordinator()
    val delivery = DeliveryForm(checkout)
    val navigation = NavigationStore()
    val orders = OrderStore(client)
    val account = AccountStore(client)
    val wishlist = WishlistStore(client)
    val notifications = NotificationsStore(client,notificationPreferences)
    val cart = CartStore(client,checkout)
    val reorder = ReorderStore(client,checkout) { cart.accept(it) }
    val comparison = ComparisonStore()
    val reviews = ReviewsStore(client)
    val support = SupportStore(client)
    val library = AssistantLibrary(client)
    var onIdentityChange: (() -> Unit)? = null
    private var generation = 0
    init {
        var previousPanel: String? = null
        navigation.onChange = {
            val leavingOrder = previousPanel in listOf("order", "notification-order") && navigation.state.value.panel != previousPanel
            previousPanel = navigation.state.value.panel
            if(leavingOrder && orders.state.value.selectedID != null) orders.show(null)
        }
        account.onIdentityChange = {
            generation++
            reorder.reset()
            comparison.reset(); reviews.reset(); support.reset(); library.reset()
            feedback.clear(); orders.reset(); navigation.resetCustomerRoutes(preserveAuthentication = account.state.value.customer == null); operations.invalidatePending(); checkout.reset(); delivery.reset(); cart.reset(); wishlist.reset(); notifications.reset(); onIdentityChange?.invoke()
        }
    }
    suspend fun perform(kind: OperationKind = OperationKind.Mutation, locale: String = "en", operation: suspend () -> Unit): Boolean =
        feedback.perform(operations,kind,locale,onUnauthorized={account.reset()},operation=operation)
    val workflows = ShoppingWorkflows(
        restoreAccount = {
            try { account.restore(); true }
            catch (failure: CommerceFailure) {
                if (failure.status != 401) throw failure
                if (account.state.value.customer != null) account.reset()
                false
            }
        },
        recoverySteps = listOf(
            {
                val expected = generation
                checkout.invalidate()
                val pending = client.pendingCheckout()?.quote
                if (expected != generation) throw kotlinx.coroutines.CancellationException("Session changed")
                checkout.restore(pending)
            },
            { delivery.refresh(client) }, { cart.refresh() }, { orders.refresh() }
        ),
        revision = { generation },
        saveItem = { cart.saveForLater(it) },
        refreshWishlist = { wishlist.refreshIDs() }
    )
    val actions = ShoppingActions(client,account,cart,delivery,checkout,orders,wishlist,workflows) { generation }
    suspend fun reload() = workflows.reload()
}
