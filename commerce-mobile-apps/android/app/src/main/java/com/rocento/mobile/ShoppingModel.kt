package com.rocento.mobile

import java.time.LocalDate
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

class ShoppingModel(val runtime: ShoppingRuntime, val analytics: CommerceAnalytics, private val scope: CoroutineScope) {
    constructor(client: CommerceClient, analytics: CommerceAnalytics, scope: CoroutineScope,
                notificationPreferences: NotificationPreferences = MemoryNotificationPreferences(),
                settings: AppSettingsStore = AppSettingsStore(analyticsEnabled = analytics.initiallyEnabled)) :
        this(ShoppingRuntime(client, settings, scope, notificationPreferences = notificationPreferences), analytics, scope)
    val client get() = runtime.client
    val settings get() = runtime.settings

    val notificationDetails get() = session.notifications.state.value.details
    val notificationOwner get() = session.notifications.state.value.owner
    fun refreshNotifications(more: Boolean = false)=act(OperationKind.Refresh) { val owner=customer?.id ?: return@act; session.notifications.refresh(owner,more) }
    val analyticsEnabled get() = settings.state.value.analyticsEnabled
    fun consent(value:Boolean)=act {settings.consent(value) { analytics.consent(it) }}
    fun event(value:CommerceEvent){scope.launch{analytics.record(value)}}
    var cartPanel: String?
        get() = session.navigation.state.value.cartPanel
        set(value) { session.navigation.openCart(value) }
    var accountScreen: String?
        get() = session.navigation.state.value.panel
        set(value) { session.navigation.open(value) }
    val assistant = AssistantChatModel(runtime.assistant)
    val session = runtime.session
    val customer get() = session.account.state.value.customer
    val cart get() = session.cart.state.value
    val locations get() = session.delivery.state.value.locations
    var orders: List<CustomerOrder>
        get() = session.orders.state.value.orders
        set(value) { session.orders.setOrders(value) }
    var detail: CustomerOrderDetail?
        get() = session.orders.state.value.detail
        set(value) { session.orders.show(value) }
    val checkout get() = session.checkout
    val quote get() = checkout.state.value.quote
    val options get() = checkout.state.value.options
    var windows: Map<String,FulfillmentSlot>
        get() = checkout.state.value.windows
        set(value) { checkout.select(value) }
    val uncertainCheckout get() = checkout.state.value.locked
    val availability get() = session.delivery.state.value.availability
    val addressDraft get() = session.delivery.state.value.addressDraft
    var selectedLocation: String
        get() = session.delivery.state.value.selectedLocation
        set(value) { session.delivery.update { it.copy(selectedLocation = value) } }
    var method: String
        get() = session.delivery.state.value.method
        set(value) { session.delivery.update { it.copy(method = value) } }
    var source: String
        get() = session.delivery.state.value.source
        set(value) { session.delivery.update { it.copy(source = value) } }
    var date: String
        get() = session.delivery.state.value.date
        set(value) { session.delivery.update { it.copy(date = value) } }
    var asap: Boolean
        get() = session.delivery.state.value.asap
        set(value) { session.delivery.update { it.copy(asap = value) } }
    val loading get() = session.operations.loading.value
    val busy get() = loading.busy
    var error: String?
        get() = session.feedback.state.value.failure?.message
        set(value) { session.feedback.setError(value) }
    var notice: String?
        get() = session.feedback.state.value.notice
        set(value) { session.feedback.setNotice(value) }
    private val checkoutSelection get() = session.delivery.state.value.selection
    val wishlistIDs get() = session.wishlist.state.value.ids
    val wishlistProducts get() = session.wishlist.state.value.products
    val wishlistLoaded get() = session.wishlist.state.value.loaded
    val wishlistLimit get() = session.wishlist.state.value.limit
    val wishlistResolved get() = session.wishlist.state.value.resolved
    fun loadWishlist(locale:String,more:Boolean=false)=act(OperationKind.Refresh) { if(customer!=null)session.wishlist.load(locale,more) }
    fun saveProduct(product:Product,saved:Boolean)=act { session.wishlist.save(product.id,saved,product) }
    fun removeSavedProduct(id:String)=act { session.wishlist.save(id,false) }
    fun act(kind: OperationKind = OperationKind.Mutation, operation: suspend () -> Unit) {
        scope.launch(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) { session.perform(kind,settings.state.value.locale,operation) }
    }

    fun load()=act(if(customer==null) OperationKind.Initial else OperationKind.Refresh) {
        session.workflows.recover()
    }
    fun login(identifier:String,password:String)=act {session.actions.login(identifier,password)}
    fun auth(action:String,identifier:String,password:String?=null,code:String?=null,onSuccess:()->Unit={})=act {
        session.actions.auth(action,identifier,password,code)
        notice="Request completed. Check your email or phone when a code is needed.";onSuccess()
    }
    fun logout()=act {session.actions.logout { OrderPush.logout() }}
    fun add(id:String,quantity:Int=1)=act {session.cart.add(id,quantity);notice="Added to your bag";event(CommerceEvent.ADDED)}
    suspend fun refreshAssistantCart() {
        if(customer==null)return
        session.perform(OperationKind.Refresh,settings.state.value.locale) {session.actions.assistantSettled()}
    }
    suspend fun applyProposal(id:String,location:String?) {
        session.operations.run {
            session.actions.applyProposal(id,location)
        }
    }
    fun addAssistantProduct(id:String,locale:String,openProduct:(String)->Unit)=act {
        session.actions.addAssistantProduct(id,locale,openProduct) {
            notice=if(locale=="ar")"تمت الإضافة إلى السلة" else "Added to your bag";event(CommerceEvent.ADDED)
        }
    }
    val canCheckDelivery get() = !uncertainCheckout && cart?.fully_reserved==true && cart?.items?.isNotEmpty()==true &&
        (if(method=="pickup") source.isNotEmpty() else selectedLocation.isNotEmpty()) && availability?.methods?.any{it.type==method}==true
    val canReviewCart get() = canCheckDelivery && customer?.verified==true && options?.groups?.isNotEmpty()==true &&
        (asap || options!!.groups.all { group -> windows[group.source_id]?.let { chosen -> group.slots.any { it.id==chosen.id && it.availability=="AVAILABLE" } } == true })
    fun quantity(id:String,value:Int)=act {session.cart.quantity(id,value)}
    fun applyCoupon(code:String)=act {session.cart.coupon(code)}
    fun saveCartItem(item:CommerceCartItem)=act {
        session.workflows.saveForLater(item.product_id)
    }
    fun choose(id:String,onChosen:()->Unit = {})=act {session.actions.choose(id);onChosen()}
    fun save(pin:DeliveryPin,address:String,building:String,floor:String,apartment:String,instructions:String,onSaved:()->Unit)=act {
        session.actions.save(pin,address,building,floor,apartment,instructions);onSaved()
    }
    fun resetDelivery() { checkout.invalidate() }
    fun findOptions() = act {if(!canCheckDelivery)return@act;LocalDate.parse(date);checkout.findOptions(client,checkoutSelection)}
    fun review() = act {if(!canReviewCart)return@act;checkout.review(client,checkoutSelection);event(CommerceEvent.CHECKOUT)}
    fun place() = act {
        session.actions.place { event(CommerceEvent.ORDERED);notice="Your order is confirmed" }
    }
    val orderDetailFailed get() = session.orders.state.value.detailFailed
    val selectedOrderID get() = session.orders.state.value.selectedID
    val ordersHasMore get() = session.orders.state.value.hasMore
    fun refreshOrders(more: Boolean = false)=act(OperationKind.Refresh) { session.orders.refresh(more) }
    fun track(id:String)=act(OperationKind.Refresh) {session.orders.track(id)}

}

