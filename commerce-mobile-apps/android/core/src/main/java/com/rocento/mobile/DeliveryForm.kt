package com.rocento.mobile

import java.time.LocalDate
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

data class AddressDraft(val locationMethod: String = "pin", val geography: Map<String,String>? = null, val address: String = "", val latitude: String = "", val longitude: String = "", val building: String = "", val floor: String = "", val apartment: String = "", val instructions: String = "")

data class DeliveryFormState(
    val addressDraft: AddressDraft = AddressDraft(),
    val guestAddress: String? = null,
    val guestPin: DeliveryPin? = null,
    val locations: List<CustomerLocation> = emptyList(),
    val availability: FulfillmentAvailability? = null,
    val selectedLocation: String = "",
    val method: String = "delivery",
    val source: String = "",
    val date: String = LocalDate.now().toString(),
    val asap: Boolean = true,
) {
    val selection get() = CheckoutSelection(method, selectedLocation.takeIf { method == "delivery" && it.isNotEmpty() }, source.takeIf { method == "pickup" && it.isNotEmpty() }, date, asap)
}
class DeliveryForm(private val checkout: CheckoutFlow) {
    private val mutableState = MutableStateFlow(DeliveryFormState())
    val state = mutableState.asStateFlow()
    var onChange: (() -> Unit)? = null
    private var generation = 0
    private fun publish(value: DeliveryFormState) { mutableState.value = value; onChange?.invoke() }
    fun reset() { generation++; publish(DeliveryFormState()) }
    fun editAddress(change: (AddressDraft) -> AddressDraft) {
        if (!checkout.state.value.locked) publish(state.value.copy(addressDraft = change(state.value.addressDraft)))
    }
    fun clearAddress() { publish(state.value.copy(addressDraft = AddressDraft())) }
    fun update(change: (DeliveryFormState) -> DeliveryFormState) {
        if (checkout.state.value.locked || checkout.state.value.busy) return
        var next = change(state.value)
        if (next.method != state.value.method) {
            val method = next.availability?.methods?.firstOrNull { it.type == next.method }
            next = next.copy(asap = method?.asap == true, source = method?.locations?.firstOrNull()?.id.orEmpty())
        }
        checkout.invalidate(); publish(next)
    }
    suspend fun refresh(client: CommerceClient) {
        val revision = generation
        val locations = client.locations(); val availability = client.fulfillment()
        checkRevision(revision)
        var next = state.value.copy(locations = locations, availability = availability)
        if (!checkout.state.value.locked || next.selectedLocation.isEmpty()) {
            val selected = locations.firstOrNull { it.id == next.selectedLocation } ?: locations.firstOrNull { it.is_default } ?: locations.firstOrNull()
            val method = availability.methods.firstOrNull { it.type == next.method } ?: availability.methods.firstOrNull()
            next = next.copy(selectedLocation = selected?.id.orEmpty(), method = method?.type ?: "delivery", asap = next.asap && method?.asap == true,
                source = method?.locations?.firstOrNull { it.id == next.source }?.id ?: method?.locations?.firstOrNull()?.id.orEmpty())
        }
        val chosen = locations.firstOrNull { it.id == next.selectedLocation }
        client.setDelivery(chosen?.let { DeliveryPin(it.latitude,it.longitude) })
        checkRevision(revision); publish(next)
    }
    suspend fun choose(id: String, client: CommerceClient) {
        checkEditable(); val revision = generation
        val location = state.value.locations.firstOrNull { it.id == id } ?: throw CommerceFailure(422,"Choose a saved address")
        val pin = DeliveryPin(location.latitude,location.longitude)
        val coverage = client.coverage(pin); checkRevision(revision)
        if (coverage.configured && !coverage.deliverable) throw CommerceFailure(422,"This address is outside our delivery area")
        client.setDelivery(pin); checkRevision(revision); update { it.copy(selectedLocation = id) }
    }
    suspend fun save(client: CommerceClient, pin: DeliveryPin, address: String, building: String, floor: String, apartment: String, instructions: String, guest: Boolean = false) {
        checkEditable(); val revision = generation
        val draft = state.value.addressDraft
        val coverage = client.coverage(pin); checkRevision(revision)
        if (coverage.configured && !coverage.deliverable) throw CommerceFailure(422,"This pin is outside our delivery area")
        if (guest) {
            client.setDelivery(pin); checkRevision(revision)
            update { it.copy(guestAddress = address, guestPin = pin, selectedLocation = "") }; return
        }
        val saved = client.saveLocation(pin,address,building,floor,apartment,instructions,draft.locationMethod,draft.geography); checkRevision(revision)
        update { it.copy(selectedLocation = saved.id) }; refresh(client)
    }
    private fun checkEditable() { if (checkout.state.value.locked) throw CommerceFailure(409,"Resolve the previous checkout first") }
    private fun checkRevision(revision: Int) { if (revision != generation) throw CancellationException("Delivery session changed") }
}
