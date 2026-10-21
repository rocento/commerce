import MapKit
import RocentoCore
import SwiftUI

struct AddressView: View {
  @ObservedObject var shopping: ShoppingModel
  let locale: String
  @Environment(\.dismiss) var dismiss
  private var address: String { shopping.addressDraft.address }
  private var building: String { shopping.addressDraft.building }
  private var floor: String { shopping.addressDraft.floor }
  private var apartment: String { shopping.addressDraft.apartment }
  private var instructions: String { shopping.addressDraft.instructions }
  private var latitude: String { shopping.addressDraft.latitude }
  private var longitude: String { shopping.addressDraft.longitude }
  private var selected: CLLocationCoordinate2D? {
    guard let lat = Double(latitude), let lon = Double(longitude),
      (try? DeliveryPin(latitude: lat, longitude: lon)) != nil
    else { return nil }
    return CLLocationCoordinate2D(latitude: lat, longitude: lon)
  }
  @State private var addressStatus = ""
  private func selectPin(_ pin: CLLocationCoordinate2D) {
    shopping.addressDraft.latitude = String(pin.latitude)
    shopping.addressDraft.longitude = String(pin.longitude)
    shopping.addressDraft.address = ""
  }
  @StateObject private var locator = DeliveryLocator()
  private func t(_ en: String, _ ar: String) -> String { locale == "ar" ? ar : en }
  var body: some View {
    NavigationStack {
      Form {
        if !shopping.locations.isEmpty {
          Section(t("Saved locations", "المواقع المحفوظة")) {
            ForEach(shopping.locations) { location in
              Button(location.formatted_address) { Task {
                await shopping.choose(location.id)
                if shopping.error == nil { dismiss() }
              } }.disabled(shopping.busy)
            }
          }
        }
        Picker(t("Choose how to set your location", "اختر طريقة تحديد موقعك"), selection: $shopping.addressDraft.locationMethod) {
          Text(t("Map pin", "دبوس الخريطة")).tag("pin")
          Text(t("Manual address", "إدخال العنوان يدوياً")).tag("neighborhood")
        }.pickerStyle(.segmented)
        .onChange(of: shopping.addressDraft.locationMethod) { _, _ in
          locator.cancel()
          shopping.addressDraft.latitude = ""
          shopping.addressDraft.longitude = ""
          shopping.addressDraft.geography = nil
          addressStatus = ""
        }
        if shopping.addressDraft.locationMethod == "neighborhood" {
          DeliveryNeighborhood(shopping: shopping, locale: locale)
        } else {
        Text(
          t(
            "Tap the map or drag the pin to choose your delivery location.",
            "اضغط على الخريطة أو اسحب الدبوس لاختيار موقع التوصيل."))
        DeliveryPinMap(selected: selected) { pin in
          locator.cancel()
          selectPin(pin)
        }.frame(height: 300).clipShape(RoundedRectangle(cornerRadius: 14))
        Button(locator.locating ? t("Finding your location…", "جارٍ تحديد موقعك…") : t("Use current location", "استخدام الموقع الحالي")) {
          locator.locate { pin in
            selectPin(pin)
          }
        }.disabled(locator.locating)
        if locator.failed { Text(t("Current location is unavailable. Tap the map to choose your pin.", "الموقع الحالي غير متاح. اضغط على الخريطة لاختيار موقعك.")).foregroundStyle(.secondary) }
        if !addressStatus.isEmpty { Text(addressStatus).foregroundStyle(.secondary) }
        Link("Address data © OpenStreetMap", destination: URL(string:"https://www.openstreetmap.org/copyright")!).font(.caption)
        }
        TextField(t("Street and address", "الشارع والعنوان"), text: $shopping.addressDraft.address).textContentType(
          .fullStreetAddress)
        TextField(t("Building", "المبنى"), text: $shopping.addressDraft.building)
        TextField(t("Floor", "الطابق"), text: $shopping.addressDraft.floor)
        TextField(t("Apartment", "الشقة"), text: $shopping.addressDraft.apartment)
        TextField(t("Delivery instructions", "تعليمات التوصيل"), text: $shopping.addressDraft.instructions)
        if let error = shopping.error { Text(error).foregroundStyle(.red) }
        Button(shopping.customer == nil ? t("Use this location", "استخدم هذا الموقع") : t("Save address", "حفظ العنوان")) {
          guard let selected else { return }
          Task {
            await shopping.save(
              pin: selected, address: address, building: building, floor: floor,
              apartment: apartment, instructions: instructions)
            if shopping.error == nil { dismiss() }
          }
        }.disabled(shopping.busy || selected == nil || address.isEmpty)
      }.navigationTitle(t("Delivery address", "عنوان التوصيل")).toolbar {
        ToolbarItem(placement: .cancellationAction) { Button(t("Cancel", "إلغاء")) { dismiss() } }
      }
    }.task(id: "\(shopping.addressDraft.locationMethod):\(latitude):\(longitude):\(locale)") {
      guard shopping.addressDraft.locationMethod == "pin", let pin = selected else { return }
      let oldAddress = address
      addressStatus = t("Finding address…", "جارٍ العثور على العنوان…")
      do {
        try await Task.sleep(for:.milliseconds(700))
        let result = try await deliveryAddress(base:shopping.client.identity.commerceBaseURL,pin:pin,locale:locale)
        try Task.checkCancellation()
        if shopping.addressDraft.address == oldAddress && oldAddress.isEmpty { shopping.addressDraft.address = result }
        addressStatus = t("Review the address, then confirm your delivery location.", "تحقق من العنوان ثم أكد موقع التوصيل.")
      } catch {
        if !Task.isCancelled { addressStatus = t("Address lookup unavailable. Enter the address manually.", "تعذر العثور على العنوان. أدخله يدوياً.") }
      }
    }.onDisappear { locator.cancel(); shopping.session.delivery.clearAddress() }.environment(\.layoutDirection, locale == "ar" ? .rightToLeft : .leftToRight)
  }
}


private struct DeliveryRegion: Decodable, Identifiable {
  let code: String
  let name: String
  let name_ar: String
  var id: String { code }
}
private struct DeliveryDirectory: Decodable { let states: [DeliveryRegion] }
private struct DeliveryCity: Decodable, Identifiable {
  let id: String
  let name: String
  let aliases: [String]
  let latitude: Double
  let longitude: Double
}

private struct DeliveryNeighborhood: View {
  @ObservedObject var shopping: ShoppingModel
  let locale: String
  @State private var country = ""
  @State private var region = ""
  @State private var regions: [DeliveryRegion] = []
  @State private var cities: [DeliveryCity] = []
  @State private var search = ""
  @State private var choosingCity = true
  @State private var error = false
  @State private var loading = false
  @State private var retry = 0
  private let countries = [("EG", "Egypt", "مصر"), ("SA", "Saudi Arabia", "السعودية"), ("KW", "Kuwait", "الكويت"), ("US", "United States", "الولايات المتحدة"), ("NL", "Netherlands", "هولندا"), ("GB", "United Kingdom", "المملكة المتحدة")]
  private func t(_ en: String, _ ar: String) -> String { locale == "ar" ? ar : en }
  private func clear() {
    shopping.addressDraft.latitude = ""; shopping.addressDraft.longitude = ""; shopping.addressDraft.geography = nil
  }
  private func read<T: Decodable>(_ file: String) async throws -> T {
    let url = URL(string: "/data/delivery/\(country.lowercased())/\(file).json", relativeTo: shopping.client.identity.commerceBaseURL)!.absoluteURL
    let (data, response) = try await URLSession.shared.data(from: url)
    guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
    return try JSONDecoder().decode(T.self, from: data)
  }
  var body: some View {
    Group {
      Picker(t("Country", "الدولة"), selection: $country) {
        Text(t("Choose country", "اختر الدولة")).tag("")
        ForEach(countries, id: \.0) { item in Text(locale == "ar" ? item.2 : item.1).tag(item.0) }
      }.onChange(of: country) { _, _ in region = ""; regions = []; cities = []; search = ""; choosingCity = true; clear() }
      Picker(t("Region", "المنطقة"), selection: $region) {
        Text(t("Choose region", "اختر المنطقة")).tag("")
        ForEach(regions) { item in Text(locale == "ar" && !item.name_ar.isEmpty ? item.name_ar : item.name).tag(item.code) }
      }.disabled(regions.isEmpty).onChange(of: region) { _, _ in cities = []; search = ""; choosingCity = true; clear() }
      TextField(t("Search city or neighborhood", "ابحث عن المدينة أو الحي"), text: $search).disabled(cities.isEmpty).onChange(of: search) { _, _ in choosingCity = true }
      if loading { ProgressView() }
      if error { Text(t("Location list unavailable.", "قائمة المواقع غير متاحة.")); Button(t("Retry", "إعادة المحاولة")) { retry += 1 } }
      if let name = shopping.addressDraft.geography?["city_name"] { Button(name) { choosingCity = true }.font(.headline) }
      if choosingCity {
      ForEach(Array(cities.filter { search.isEmpty || ([$0.name] + $0.aliases).contains { $0.localizedStandardContains(search) } }.prefix(60))) { city in
        Button(city.name) {
          guard let state = regions.first(where: { $0.code == region }), (try? DeliveryPin(latitude: city.latitude, longitude: city.longitude)) != nil else { return }
          choosingCity = false
          shopping.addressDraft.latitude = String(city.latitude); shopping.addressDraft.longitude = String(city.longitude)
          shopping.addressDraft.geography = ["country_code": country, "state_code": region, "state_name": state.name, "city_id": city.id, "city_name": city.name]
        }
      }
      }
      Text(t("No pin needed. Choose your area, then enter your street and building below.", "لا يلزم دبوس. اختر منطقتك ثم أدخل الشارع والمبنى أدناه.")).font(.caption)
      Link("GeoNames · CC BY 4.0", destination: URL(string: "https://www.geonames.org/")!).font(.caption)
    }.task(id: "\(country):\(region):\(retry)") {
      guard !country.isEmpty else { return }
      loading = true; error = false
      do {
        if region.isEmpty {
          let directory: DeliveryDirectory = try await read("index")
          try Task.checkCancellation()
          guard directory.states.allSatisfy({ $0.code.range(of: "^[A-Z0-9]{1,12}$", options: .regularExpression) != nil }) else { throw URLError(.cannotParseResponse) }
          regions = directory.states
        } else {
          let result: [DeliveryCity] = try await read(region)
          try Task.checkCancellation(); cities = result
        }
        loading = false
      } catch { if !Task.isCancelled { self.error = true; loading = false } }
    }
  }
}
