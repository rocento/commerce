import Foundation

/// Public catalog media only. Full URLs (including merchant origin and size) are keys.
/// A disappearing cell releases its lease; the last lease cancels the socket.
public actor ImageDataLoader {
  public static let shared = ImageDataLoader()
  private struct Flight {
    let id: UUID
    let task: Task<Data, Error>
    var leases: Set<UUID>
  }
  private let transport: any HTTPTransport
  private var flights: [URL: Flight] = [:]
  public init(transport: any HTTPTransport = URLSessionTransport.images) { self.transport = transport }

  public func load(_ url: URL) async throws -> Data {
    try Task.checkCancellation()
    guard url.scheme == "https", url.host != nil, url.user == nil, url.password == nil else { throw MobileFailure.invalidResponse }
    let lease = UUID()
    if flights[url] == nil {
      let transport = self.transport
      flights[url] = Flight(id: UUID(), task: Task {
        var response = try await transport.get(URLRequest(url: url), maxBytes: 5 * 1024 * 1024)
        try Task.checkCancellation()
        if response.status == 404, var original = URLComponents(url: url, resolvingAgainstBaseURL: false),
          original.queryItems?.contains(where: { $0.name == "width" }) == true {
          original.queryItems = original.queryItems?.filter { $0.name != "width" }
          if let fallback = original.url { response = try await transport.get(URLRequest(url: fallback), maxBytes: 5 * 1024 * 1024) }
        }
        try Task.checkCancellation()
        guard response.status == 200, response.body.count <= 5 * 1024 * 1024 else { throw MobileFailure.invalidResponse }
        return response.body
      }, leases: [])
    }
    flights[url]!.leases.insert(lease)
    let flight = flights[url]!
    defer { release(url, id: flight.id, lease: lease) }
    return try await withTaskCancellationHandler {
      let data = try await flight.task.value
      try Task.checkCancellation()
      return data
    } onCancel: {
      Task { await self.release(url, id: flight.id, lease: lease) }
    }
  }

  private func release(_ url: URL, id: UUID, lease: UUID) {
    guard var flight = flights[url], flight.id == id, flight.leases.remove(lease) != nil else { return }
    if flight.leases.isEmpty { flights.removeValue(forKey: url); flight.task.cancel() }
    else { flights[url] = flight }
  }
}
