import Foundation

public struct Product: Codable, Identifiable, Sendable {
  public let id: String
  public let name: String
  public let description: String
  public let price: String
  public let currency: String
  public let nameAr: String?
  public let descriptionAr: String?
  public let symbol: String?
  public let inStock: Bool
  public let mediaIDs: [String]?
  public let productType: String?
  public var active: Bool? = nil
  public var attributes: Artwork? = nil
  public var catalogOffer: Offer? = nil
  public struct Artwork: Codable, Sendable { public let thumbnail: String?; enum CodingKeys: String, CodingKey { case thumbnail = "demo-thumbnail" } }
  public struct Offer: Codable, Sendable { public let product_id: String; public let currency: String; public let original_price: String; public let discounted_price: String }
  public var thumbnail: String? { attributes?.thumbnail ?? mediaIDs?.first }
  public var displayPrice: String {
    guard let o = catalogOffer, o.product_id == id, o.currency == currency, let base = Decimal(string: price), let original = Decimal(string: o.original_price), let discount = Decimal(string: o.discounted_price), base == original, discount >= 0, discount < base else { return price }; return o.discounted_price
  }
  enum CodingKeys: String, CodingKey {
    case id, name, description, price, currency, nameAr, descriptionAr, symbol, active, attributes
    case catalogOffer = "catalog_offer"
    case inStock = "in_stock"
    case mediaIDs = "media_ids"
    case productType = "product_type"
  }
  public func title(_ locale: String) -> String { locale == "ar" ? nameAr ?? name : name }
  public func detail(_ locale: String) -> String {
    locale == "ar" ? descriptionAr ?? description : description
  }
}
public struct Category: Codable, Identifiable, Sendable {
  public let id: String
  public let name: String
  public let nameAr: String?
  public let slug: String
  public var thumbnail: String? = nil
  public var parent_id: String? = nil
  public func title(_ locale: String) -> String { locale == "ar" ? nameAr ?? name : name }
}
public struct CatalogFixture: Codable, Sendable {
  public let merchantId: String
  public let categories: [Category]
  public let products: [Product]
}
public protocol CatalogServing: Sendable {
  func categories(locale: String) async throws -> [Category]
  func products(category: String?, locale: String) async throws -> [Product]
  func product(id: String, locale: String) async throws -> Product
  func attributes(locale: String) async throws -> [CatalogAttribute]
  func browse(category: String, filters: CatalogFilters, offset: Int, locale: String) async throws -> CatalogPage
}
public struct FixtureCatalog: CatalogServing {
  let fixture: CatalogFixture
  public init(data: Data, identity: AppIdentity) throws {
    fixture = try JSONDecoder().decode(CatalogFixture.self, from: data)
    guard fixture.merchantId == identity.merchantID else { throw MobileFailure.wrongMerchant }
  }
  public func categories(locale: String) async throws -> [Category] { fixture.categories }
  public func products(category: String?, locale: String) async throws -> [Product] {
    guard
      category == nil
        || fixture.categories.contains(where: { $0.id == category || $0.slug == category })
    else { throw MobileFailure.invalidResponse }
    return fixture.products
  }
  public func product(id: String, locale: String) async throws -> Product {
    guard let product = fixture.products.first(where: { $0.id == id }) else {
      throw MobileFailure.invalidResponse
    }
    return product
  }
}
public struct CommerceCatalog: CatalogServing {
  let identity: AppIdentity
  let transport: any HTTPTransport
  public init(identity: AppIdentity, transport: any HTTPTransport = URLSessionTransport()) {
    self.identity = identity
    self.transport = transport
  }
  private func get<T: Decodable>(_ path: String, query: [URLQueryItem] = [], locale: String)
    async throws -> T
  {
    var url = URLComponents(
      url: identity.commerceBaseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
    url.queryItems = query.isEmpty ? nil : query
    var request = URLRequest(url: url.url!)
    request.setValue(locale == "ar" ? "ar" : "en", forHTTPHeaderField: "X-Storefront-Locale")
    // Config enrollment credentials are NEVER commerce credentials.
    let response = try await transport.get(request, maxBytes: 2_000_000)
    guard response.status == 200 else { throw MobileFailure.invalidResponse }
    return try JSONDecoder().decode(T.self, from: response.body)
  }
  public func categories(locale: String) async throws -> [Category] {
    try await get("v1/catalog/categories", locale: locale)
  }
  public func products(category: String?, locale: String) async throws -> [Product] {
    if let category, category.hasPrefix("demo-feed-") {
      let theme: DemoTheme = try await get("v1/theme/storefront", locale: locale)
      let feed = try theme.feed(String(category.dropFirst(10)))
      if feed.bestsellers {
        struct Best: Decodable { let products: [Product] }
        let result: Best = try await get(feed.path, query: feed.query, locale: locale)
        return Array(result.products.filter { $0.active != false }.prefix(feed.limit))
      }
      struct Search: Decodable { let hits: [Product] }
      let result: Search = try await get(feed.path, query: feed.query, locale: locale)
      return Array(result.hits.filter { $0.active != false }.prefix(feed.limit))
    }
    var query = [URLQueryItem(name: "q", value: "")]
    if let category {
      let id: String
      if UUID(uuidString: category) != nil {
        id = category
      } else {
        guard let match = try await categories(locale: locale).first(where: { $0.slug == category })
        else { throw MobileFailure.invalidResponse }
        id = match.id
      }
      query.append(.init(name: "category_id", value: id))
    }
    struct Results: Decodable { let hits: [Product] }
    let result: Results = try await get("v1/search", query: query, locale: locale)
    return result.hits
  }
  public func attributes(locale: String) async throws -> [CatalogAttribute] { try await get("v1/catalog/attribute-definitions", locale: locale) }
  public func browse(category: String, filters: CatalogFilters, offset: Int, locale: String) async throws -> CatalogPage {
    guard filters.valid else { throw MobileFailure.invalidResponse }
    let id: String
    if category.isEmpty { id = "" } else {
      guard let found = try await categories(locale: locale).first(where: { $0.id == category || $0.slug == category })?.id else { throw MobileFailure.invalidResponse }
      id = found
    }
    return try await get("v1/search", query: filters.parameters(category: id, offset: offset), locale: locale)
  }
  public func product(id: String, locale: String) async throws -> Product {
    guard UUID(uuidString: id) != nil else { throw MobileFailure.invalidResponse }
    return try await get("v1/catalog/products/\(id)", locale: locale)
  }
}

public struct ProductFamily: Decodable, Sendable { public let children: [Product] }

public struct CatalogFilters: Equatable, Sendable {
  public var query = ""
  public var minimum = ""
  public var maximum = ""
  public var inStock = false
  public var sort = "relevance"
  public var attributes: [String: [String]] = [:]
  public var attributeTypes: [String: String] = [:]
  public init() {}
  public var valid: Bool {
    let low = minimum.isEmpty ? 0 : Double(minimum) ?? -1
    let high = maximum.isEmpty ? Double.infinity : Double(maximum) ?? -1
    let numericValid = attributes.allSatisfy { code, values in
      !["integer", "decimal", "measurement", "price"].contains(attributeTypes[code] ?? "") || values.allSatisfy { Double($0)?.isFinite == true }
    }
    return numericValid && query.count <= 120 && low.isFinite && low >= 0 && high >= low && (maximum.isEmpty || high.isFinite)
  }
  public func parameters(category: String, offset: Int) -> [URLQueryItem] {
    var values = [URLQueryItem(name: "q", value: query), .init(name: "category_id", value: category), .init(name: "offset", value: String(offset)), .init(name: "limit", value: "24")]
    if category.isEmpty { values.removeAll { $0.name == "category_id" } }
    if !minimum.isEmpty { values.append(.init(name: "min_price", value: minimum)) }
    if !maximum.isEmpty { values.append(.init(name: "max_price", value: maximum)) }
    if inStock { values.append(.init(name: "in_stock", value: "true")) }
    if sort != "relevance" {
      values.append(.init(name: "sort_by", value: sort.contains(":") ? String(sort.split(separator: ":")[0]) : sort.hasPrefix("name_") ? "name" : "price"))
      values.append(.init(name: "sort_order", value: sort.hasSuffix("desc") ? "desc" : "asc"))
    }
    if !attributes.isEmpty {
      let typed = attributes.mapValues { $0 as Any }
      var payload = typed
      for (code, selections) in attributes {
        let type = attributeTypes[code] ?? "text"
        if type == "boolean" { payload[code] = selections.map { $0 == "true" } }
        else if ["integer", "decimal", "measurement", "price"].contains(type) { payload[code] = selections.compactMap(Double.init) }
      }
      if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]), let json = String(data: data, encoding: .utf8) { values.append(.init(name: "attribute_filters", value: json)) }
    }
    return values
  }
}
public struct CatalogPage: Decodable, Sendable {
  public let hits: [Product]
  public let total: Int
  public var facets: [String: [String: Int]]? = nil
}
public extension CatalogServing {
  func attributes(locale: String) async throws -> [CatalogAttribute] { [] }
  func browse(category: String, filters: CatalogFilters, offset: Int, locale: String) async throws -> CatalogPage {
    guard filters.valid else { throw MobileFailure.invalidResponse }
    var matches = try await products(category: category.isEmpty ? nil : category, locale: locale).filter {
      (filters.query.isEmpty || $0.title(locale).localizedCaseInsensitiveContains(filters.query)) &&
      (!filters.inStock || $0.inStock) &&
      (Double($0.price) ?? 0) >= (Double(filters.minimum) ?? 0) &&
      (Double($0.price) ?? 0) <= (Double(filters.maximum) ?? .infinity)
    }
    switch filters.sort {
    case "price_asc": matches.sort { (Double($0.price) ?? 0) < (Double($1.price) ?? 0) }
    case "price_desc": matches.sort { (Double($0.price) ?? 0) > (Double($1.price) ?? 0) }
    case "name_desc": matches.sort { $0.title(locale) > $1.title(locale) }
    case "name_asc": matches.sort { $0.title(locale) < $1.title(locale) }
    default: break
    }
    return CatalogPage(hits: Array(matches.dropFirst(max(0, offset)).prefix(24)), total: matches.count)
  }
}

public struct CatalogAttribute: Decodable, Identifiable, Sendable {
  public let attribute_code: String
  public let label: String
  public let input_type: String
  public let is_filterable: Bool
  public let is_visible_on_front: Bool
  public let options: [Option]
  public let metadata: Metadata?
  public var id: String { attribute_code }
  public var visible: Bool { is_filterable && is_visible_on_front && metadata?.status != "disabled" }
  public struct Option: Decodable, Identifiable, Sendable { public let value: String; public let label: String; public var id: String { value } }
  public struct Metadata: Decodable, Sendable { public let status: String?; public let facetable: Bool?; public let display_order: Int?; public let sortable: Bool? }
  public var usesChoices: Bool {
    ["boolean", "select", "multiselect", "single_select", "multi_select"].contains(input_type)
      || (["text", "textarea", "long_text"].contains(input_type) && metadata?.facetable == true)
  }
  public func showsFilter(facets: [String: Int]?, selected: [String]) -> Bool {
    visible && (!usesChoices || metadata?.facetable != true || facets == nil || !choices(facets: facets, selected: selected).isEmpty)
  }
  public func choices(facets: [String: Int]?, selected: [String]) -> [String] {
    let base = input_type == "boolean" ? ["true", "false"] : options.isEmpty ? (facets?.keys.sorted() ?? []) : options.map(\.value)
    return Array(Set(base + selected)).sorted().filter { metadata?.facetable != true || facets == nil || (facets?[$0] ?? 0) > 0 || selected.contains($0) }
  }
}

// Resolve only enabled sections from this installation's compiled storefront origin.
struct DemoTheme: Decodable {
  let configuration: Configuration
  struct Configuration: Decodable { let pages: Pages }
  struct Pages: Decodable { let home: [Home] }
  struct Home: Decodable { let id: String; let enabled: Bool; let component: String; let settings: Settings }
  struct Settings: Decodable { let query: String?; let category: String?; let limit: Int?; let period: String? }
  struct Feed { let path: String; let query: [URLQueryItem]; let limit: Int; let bestsellers: Bool }
  func feed(_ id: String) throws -> Feed {
    guard let section = configuration.pages.home.first(where: { $0.id == id && $0.enabled }), ["featured_products", "product_collection", "recommendations", "best_sellers"].contains(section.component) else { throw MobileFailure.invalidResponse }
    let s = section.settings, limit = min(24, max(1, section.settings.limit ?? 8))
    if section.component == "best_sellers" {
      let period = s.period ?? "last_month"
      guard ["today", "last_week", "last_month", "last_year"].contains(period) else { throw MobileFailure.invalidResponse }
      return Feed(path: "v1/catalog/bestsellers", query: [.init(name: "period", value: period), .init(name: "limit", value: String(limit))], limit: limit, bestsellers: true)
    }
    var query = [URLQueryItem(name: "q", value: s.query ?? "")]
    if let category = s.category, !category.isEmpty { query.append(.init(name: "category_id", value: category)) }
    return Feed(path: "v1/search", query: query, limit: limit, bestsellers: false)
  }
}
