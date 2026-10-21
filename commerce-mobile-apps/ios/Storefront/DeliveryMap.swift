import RocentoCore
import CoreLocation
import MapKit
import SwiftUI

private enum LocationEvent: Sendable {
  case authorization(Int32)
  case location(Double, Double)
  case failure
}

/// Core Location owns callback delivery; only Sendable values cross into UI state.
private final class LocationDelegate: NSObject, CLLocationManagerDelegate {
  let receive: @Sendable (LocationEvent) -> Void
  init(receive: @escaping @Sendable (LocationEvent) -> Void) { self.receive = receive }
  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    receive(.authorization(manager.authorizationStatus.rawValue))
  }
  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    guard let location = locations.last, location.horizontalAccuracy >= 0 else { return }
    receive(.location(location.coordinate.latitude, location.coordinate.longitude))
  }
  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) { receive(.failure) }
}

@MainActor final class DeliveryLocator: ObservableObject {
  @Published var locating = false
  @Published var failed = false
  private var manager: CLLocationManager?
  private var delegate: LocationDelegate?
  private var requestState = LocationRequest()
  private var requested = false
  private var completion: ((CLLocationCoordinate2D) -> Void)?
  private var timeout: Task<Void, Never>?
  func locate(_ completion: @escaping (CLLocationCoordinate2D) -> Void) {
    cancel()
    let id = requestState.begin()
    self.completion = completion; locating = true; failed = false
    let delegate = LocationDelegate { [weak self] event in
      Task { @MainActor [weak self] in self?.receive(event, id: id) }
    }
    let manager = CLLocationManager()
    self.manager = manager; self.delegate = delegate
    manager.delegate = delegate
    manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    receive(.authorization(manager.authorizationStatus.rawValue), id: id)
  }
  private func receive(_ event: LocationEvent, id: UUID) {
    guard requestState.accepts(id) else { return }
    switch event {
    case .authorization(let raw):
      guard let manager else { return }
      switch CLAuthorizationStatus(rawValue: raw) {
      case .notDetermined: manager.requestWhenInUseAuthorization()
      case .authorizedWhenInUse, .authorizedAlways:
        guard !requested else { return }
        requested = true; manager.requestLocation()
        timeout = Task { [weak self] in
          do { try await Task.sleep(for: .seconds(15)) } catch { return }
          self?.receive(.failure, id: id)
        }
      default: cancel(); failed = true
      }
    case .location(let latitude, let longitude):
      let callback = completion; cancel()
      callback?(CLLocationCoordinate2D(latitude: latitude, longitude: longitude))
    case .failure: cancel(); failed = true
    }
  }
  func cancel() {
    requestState.cancel(); timeout?.cancel(); timeout = nil
    completion = nil; locating = false; requested = false
    manager?.stopUpdatingLocation(); manager?.delegate = nil
    manager = nil; delegate = nil
  }
}

struct DeliveryPinMap: UIViewRepresentable {
  let selected: CLLocationCoordinate2D?
  let onPin: (CLLocationCoordinate2D) -> Void
  func makeCoordinator() -> Coordinator { Coordinator(self) }
  func makeUIView(context: Context) -> MKMapView {
    let map = MKMapView(); map.delegate = context.coordinator
    map.setRegion(MKCoordinateRegion(center: selected ?? CLLocationCoordinate2D(latitude: 30.0444, longitude: 31.2357), span: MKCoordinateSpan(latitudeDelta: 0.03, longitudeDelta: 0.03)), animated: false)
    map.addGestureRecognizer(UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tap(_:))))
    map.accessibilityLabel = "Delivery map"
    return map
  }
  func updateUIView(_ map: MKMapView, context: Context) {
    context.coordinator.parent = self
    guard let selected else { return }
    let pin = context.coordinator.pin
    if !map.annotations.contains(where: { $0 === pin }) { map.addAnnotation(pin) }
    if abs(pin.coordinate.latitude-selected.latitude) > 0.000001 || abs(pin.coordinate.longitude-selected.longitude) > 0.000001 {
      pin.coordinate = selected
      map.setCenter(selected, animated: true)
    }
  }
  final class Coordinator: NSObject, MKMapViewDelegate {
    var parent: DeliveryPinMap
    let pin = MKPointAnnotation()
    init(_ parent: DeliveryPinMap) { self.parent = parent; pin.title = "Delivery pin" }
    @objc func tap(_ gesture: UITapGestureRecognizer) {
      guard let map = gesture.view as? MKMapView else { return }
      parent.onPin(map.convert(gesture.location(in: map), toCoordinateFrom: map))
    }
    func mapView(_ mapView: MKMapView, viewFor annotation: MKAnnotation) -> MKAnnotationView? {
      guard annotation === pin else { return nil }
      let view = MKMarkerAnnotationView(annotation: pin, reuseIdentifier: "delivery-pin")
      view.isDraggable = true; view.markerTintColor = UIColor(red: 0.02, green: 0.24, blue: 0.13, alpha: 1)
      return view
    }
    func mapView(_ mapView: MKMapView, annotationView view: MKAnnotationView, didChange newState: MKAnnotationView.DragState, fromOldState oldState: MKAnnotationView.DragState) {
      if newState == .ending { parent.onPin(pin.coordinate); view.dragState = .none }
    }
  }
}

/// Shared commerce endpoint; no customer credentials are needed for map address suggestions.
func deliveryAddress(base: URL, pin: CLLocationCoordinate2D, locale: String) async throws -> String {
  var url = URLComponents(url: base.appendingPathComponent("v1/location-address"), resolvingAgainstBaseURL: false)!
  url.queryItems = [URLQueryItem(name:"lat",value:String(format:"%.6f",locale:Locale(identifier:"en_US_POSIX"),pin.latitude)),URLQueryItem(name:"lon",value:String(format:"%.6f",locale:Locale(identifier:"en_US_POSIX"),pin.longitude)),URLQueryItem(name:"lang",value:locale == "ar" ? "ar" : "en")]
  var request = URLRequest(url:url.url!); request.timeoutInterval = 12
  let result = try await URLSessionTransport().get(request,maxBytes:128000)
  guard result.status == 200, let data = try JSONSerialization.jsonObject(with:result.body) as? [String:Any],
    let features = data["features"] as? [[String:Any]], let p = features.first?["properties"] as? [String:Any]
  else { throw URLError(.badServerResponse) }
  func value(_ key:String)->String { (p[key] as? String ?? "").trimmingCharacters(in:.whitespacesAndNewlines) }
  let street = value("street").isEmpty ? value("name") : value("street")
  guard !street.isEmpty else { throw URLError(.badServerResponse) }
  var parts:[String]=[]
  for item in [street,value("district"),value("city"),value("state"),value("country")] where !item.isEmpty && !parts.contains(item) { parts.append(item) }
  return String(parts.joined(separator:", ").prefix(200))
}
