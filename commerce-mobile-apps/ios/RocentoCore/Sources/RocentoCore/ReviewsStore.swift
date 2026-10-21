import Foundation

public struct ReviewInput: Codable, Equatable, Sendable {
  public var display_name = ""
  public var rating = 5
  public var title = ""
  public var body = ""
  public init() {}
  public var valid: Bool { (1...5).contains(rating) && [(display_name, 80), (title, 200), (body, 4000)].allSatisfy { !$0.0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.0.utf8.count <= $0.1 } }
}
public struct ProductReview: Decodable, Identifiable, Sendable {
  public let id: String
  public let display_name: String
  public let rating: Int
  public let title: String
  public let body: String
  public let created_at: String
  public let status: String?
  public let version: Int?
  public let moderation_reason: String?
  public var input: ReviewInput { var value = ReviewInput(); value.display_name = display_name; value.rating = rating; value.title = title; value.body = body; return value }
}
@MainActor public final class ReviewsStore {
  public private(set) var product = ""
  public private(set) var reviews: [ProductReview] = []
  public private(set) var own: ProductReview?
  public private(set) var draft = ReviewInput()
  public private(set) var offset = 0
  public private(set) var busy = false
  public private(set) var loaded = false
  public private(set) var ownLoaded = false
  public private(set) var failed = false
  public private(set) var dirty = false
  public private(set) var uncertain = false
  public private(set) var submitted = false
  public var onChange: (() -> Void)?
  private var generation = 0
  private let client: CommerceClient
  public init(client: CommerceClient) { self.client = client }
  public func reset() { generation += 1; product = ""; reviews = []; own = nil; draft = ReviewInput(); offset = 0; busy = false; loaded = false; ownLoaded = false; failed = false; dirty = false; uncertain = false; submitted = false; onChange?() }
  public func edit(_ input: ReviewInput) { guard !busy, !uncertain else { return }; draft = input; dirty = true; submitted = false; onChange?() }
  private func check(_ revision: Int) throws { guard revision == generation, !Task.isCancelled else { throw CancellationError() } }
  public func open(_ id: String, signedIn: Bool) async throws { reset(); product = id; try await load(signedIn: signedIn, offset: 0) }
  public func load(signedIn: Bool, offset requested: Int? = nil) async throws {
    guard !busy else { return }; let revision = generation
    busy = true; failed = false; onChange?()
    defer { if revision == generation { busy = false; onChange?() } }
    do {
      let page = max(0, requested ?? offset)
      let items = try await client.reviews(product, offset: page); try check(revision)
      reviews = items; offset = page; loaded = true
      let value = signedIn ? try await client.ownReview(product) : nil; try check(revision)
      own = value; ownLoaded = true; uncertain = false
      if !dirty { draft = value?.input ?? ReviewInput() }
    } catch { if revision == generation { failed = true }; throw error }
  }
  public func submit(verified: Bool) async throws {
    guard !busy, ownLoaded, !uncertain, verified, draft.valid else { throw CommerceFailure(422, "Verify your account and complete a valid review") }
    let revision = generation; busy = true; submitted = false; uncertain = true; onChange?()
    defer { if revision == generation { busy = false; onChange?() } }
    let value = try await client.submitReview(product, input: draft); try check(revision)
    own = value; draft = value.input; dirty = false; submitted = true; uncertain = false; reviews.removeAll { $0.id == value.id }
    do { let items = try await client.reviews(product, offset: offset); try check(revision); reviews = items; failed = false }
    catch { if revision == generation { failed = true } }
  }
}
