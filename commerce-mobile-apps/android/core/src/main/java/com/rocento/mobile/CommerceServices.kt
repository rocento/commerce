package com.rocento.mobile

interface AccountServing {
    suspend fun restore(): CustomerAccount
    suspend fun me(): CustomerAccount
    suspend fun login(identifier: String, password: String): CustomerAccount
    suspend fun logout()
    suspend fun authAction(action: String, identifier: String, password: String? = null, code: String? = null)
}
interface CartServing {
    suspend fun cart(): CommerceCart
    suspend fun add(id: String, quantity: Int = 1): CommerceCart
    suspend fun quantity(id: String, quantity: Int): CommerceCart
    suspend fun coupon(code: String): CommerceCart
    suspend fun saveProduct(id: String, saved: Boolean)
}
interface CheckoutServing {
    suspend fun deliveryOptions(method: String, location: String?, source: String?, date: String, asap: Boolean): FulfillmentOptions
    suspend fun reserveDelivery(method: String, location: String?, source: String?, date: String, asap: Boolean, windows: List<FulfillmentSlot>, key: String)
    suspend fun quote(location: String?, giftMessage: String = ""): CommerceQuote
    suspend fun pendingCheckout(): CheckoutAttempt?
    suspend fun place(quote: CommerceQuote): CustomerOrderDetail
}
interface OrderServing {
    suspend fun orders(offset: Int = 0): List<CustomerOrder>
    suspend fun order(id: String): CustomerOrderDetail
}
