import Foundation

public struct AddressDraft {
  public var locationMethod = "pin"
  public var geography: [String: String]?
  public var address = ""
  public var latitude = ""
  public var longitude = ""
  public var building = ""
  public var floor = ""
  public var apartment = ""
  public var instructions = ""
  public init() {}
}

public struct DeliveryFormState {
  public var addressDraft = AddressDraft()
  public var guestAddress: String?
  public var guestPin: DeliveryPin?
  public var locations: [CustomerLocation] = []
  public var availability: FulfillmentAvailability?
  public var selectedLocation = ""
  public var method = "delivery"
  public var source = ""
  public var date = Date()
  public var asap = true
  public init() {}
  public var selection: CheckoutSelection {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "yyyy-MM-dd"
    return CheckoutSelection(method: method,
      location: method == "delivery" && !selectedLocation.isEmpty ? selectedLocation : nil,
      source: method == "pickup" && !source.isEmpty ? source : nil,
      date: formatter.string(from: date), asap: asap)
  }
}

@MainActor public final class DeliveryForm {
  public private(set) var state = DeliveryFormState()
  public var onChange: (() -> Void)?
  private let checkout: CheckoutFlow
  private var generation = 0
  public init(checkout: CheckoutFlow) { self.checkout = checkout }
  public func reset() { generation += 1; state = DeliveryFormState(); onChange?() }
  public func editAddress(_ draft: AddressDraft) {
    guard !checkout.locked else { return }
    state.addressDraft = draft; onChange?()
  }
  public func clearAddress() { state.addressDraft = AddressDraft(); onChange?() }
  public func update(_ change: (inout DeliveryFormState) -> Void) {
    guard !checkout.locked && !checkout.busy else { return }
    let oldMethod = state.method
    change(&state)
    if oldMethod != state.method {
      let method = state.availability?.methods.first { $0.type == state.method }
      state.asap = method?.asap == true; state.source = method?.locations?.first?.id ?? ""
    }
    checkout.invalidate(); onChange?()
  }
  public func refresh(client: CommerceClient) async throws {
    let revision = generation
    let locations = try await client.locations()
    let availability = try await client.fulfillment()
    guard revision == generation else { throw CancellationError() }
    state.locations = locations; state.availability = availability
    if !checkout.locked || state.selectedLocation.isEmpty {
      if !locations.contains(where: { $0.id == state.selectedLocation }) {
        state.selectedLocation = (locations.first { $0.is_default } ?? locations.first)?.id ?? ""
      }
      if !availability.methods.contains(where: { $0.type == state.method }) {
        state.method = availability.methods.first?.type ?? "delivery"
      }
      let method = availability.methods.first { $0.type == state.method }
      if method?.asap != true { state.asap = false }
      if method?.locations?.contains(where: { $0.id == state.source }) != true { state.source = method?.locations?.first?.id ?? "" }
    }
    let chosen = locations.first { $0.id == state.selectedLocation }
    await client.setDelivery(try chosen.map { try DeliveryPin(latitude: $0.latitude, longitude: $0.longitude) })
    guard revision == generation else { throw CancellationError() }
    onChange?()
  }
  public func choose(_ id: String, client: CommerceClient) async throws {
    guard !checkout.locked else { throw CommerceFailure(409, "Resolve the previous checkout first") }
    guard let location = state.locations.first(where: { $0.id == id }) else { throw CommerceFailure(422, "Choose a saved address") }
    let revision = generation
    let pin = try DeliveryPin(latitude: location.latitude, longitude: location.longitude)
    let coverage = try await client.coverage(pin)
    guard revision == generation else { throw CancellationError() }
    guard !coverage.configured || coverage.deliverable else { throw CommerceFailure(422, "This address is outside our delivery area") }
    await client.setDelivery(pin)
    guard revision == generation else { throw CancellationError() }
    update { $0.selectedLocation = id }
  }
  public func save(client: CommerceClient, pin: DeliveryPin, address: String, building: String, floor: String, apartment: String, instructions: String, guest: Bool = false) async throws {
    guard !checkout.locked else { throw CommerceFailure(409, "Resolve the previous checkout first") }
    let revision = generation
    let draft = state.addressDraft
    let coverage = try await client.coverage(pin)
    guard revision == generation else { throw CancellationError() }
    guard !coverage.configured || coverage.deliverable else { throw CommerceFailure(422, "This pin is outside our delivery area") }
    if guest {
      await client.setDelivery(pin)
      guard revision == generation else { throw CancellationError() }
      update { $0.guestAddress = address; $0.guestPin = pin; $0.selectedLocation = "" }
      return
    }
    let saved = try await client.saveLocation(pin: pin, address: address, building: building, floor: floor, apartment: apartment, instructions: instructions, locationMethod: draft.locationMethod, geography: draft.geography)
    guard revision == generation else { throw CancellationError() }
    update { $0.selectedLocation = saved.id }
    try await refresh(client: client)
  }
}
