import Foundation

@MainActor public final class CatalogStore {
  public var onChange: (() -> Void)?
  public private(set) var locale: String
  private let catalog: any CatalogServing
  public init(catalog: any CatalogServing, locale: String = "en") { self.catalog = catalog; self.locale = locale }
  private func copy(_ en: String, _ ar: String) -> String { locale == "ar" ? ar : en }
  public private(set) var products: [Product] = [] { didSet { onChange?() } }
  public private(set) var collections: [String: [Product]] = [:] { didSet { onChange?() } }
  public private(set) var categories: [RocentoCore.Category] = [] { didSet { onChange?() } }
  public private(set) var selectedCategory: String? = nil { didSet { onChange?() } }
  public private(set) var categoryProducts: [Product] = [] { didSet { onChange?() } }
  public var categoryFilters = CatalogFilters() {
    didSet { onChange?(); if categoryFilters != oldValue { scheduleCategoryFilters() } }
  }
  private var categoryFilterTask: Task<Void, Never>?
  public private(set) var categoryAttributes: [CatalogAttribute] = [] { didSet { onChange?() } }
  public private(set) var categoryFacets: [String: [String: Int]] = [:] { didSet { onChange?() } }
  public private(set) var categoryTotal = 0 { didSet { onChange?() } }
  public private(set) var categoryHasMore = false { didSet { onChange?() } }
  private var categoryOffset = 0
  public private(set) var categoryLoading = false { didSet { onChange?() } }
  public private(set) var categoryError: String? = nil { didSet { onChange?() } }
  private var appliedCategoryFilters = CatalogFilters()
  private var categoryRequest = UUID()
  public private(set) var selectedProduct: Product? = nil { didSet { onChange?() } }
  public private(set) var variants: [Product] = [] { didSet { onChange?() } }
  public func search(_ query: String) async {
    selectedCategory = ""
    categoryFilters = CatalogFilters()
    categoryFilters.query = String(query.trimmingCharacters(in: .whitespacesAndNewlines).prefix(120))
    await browseCategory()
  }
  public func category(_ id: String) async {
    selectedCategory = id
    categoryFilters = CatalogFilters()
    categoryAttributes = []; categoryFacets = [:]
    await browseCategory()
  }
  public func closeCategory() {
    categoryFilterTask?.cancel()
    categoryFilterTask = nil
    categoryRequest = UUID()
    selectedCategory = nil
    categoryLoading = false
  }
  private func scheduleCategoryFilters() {
    categoryFilterTask?.cancel()
    categoryRequest = UUID() // Ignore responses for filters that have already changed.
    categoryLoading = false
    guard selectedCategory != nil, categoryFilters.valid else { return }
    categoryFilterTask = Task { [weak self] in
      do { try await Task.sleep(for: .milliseconds(300)) } catch { return }
      guard let self, !Task.isCancelled else { return }
      self.categoryFilterTask = nil
      await self.browseCategory()
    }
  }
  public func browseCategory(more: Bool = false) async {
    if !more { categoryFilterTask?.cancel(); categoryFilterTask = nil }
    guard let id = selectedCategory, more || categoryFilters.valid else { return }
    if more && (!categoryHasMore || categoryLoading || categoryFilters != appliedCategoryFilters) { return }
    let request = UUID(), language = locale
    categoryRequest = request
    if !more { appliedCategoryFilters = categoryFilters; categoryProducts = []; categoryTotal = 0; categoryOffset = 0; categoryHasMore = false }
    let filters = appliedCategoryFilters, offset = categoryOffset
    categoryLoading = true
    categoryError = nil
    defer { if categoryRequest == request { categoryLoading = false } }
    do {
      async let definitionRequest = catalog.attributes(locale: language)
      async let pageRequest = catalog.browse(category: id, filters: filters, offset: offset, locale: language)
      let (definitions, page) = try await (definitionRequest, pageRequest)
      guard categoryRequest == request, selectedCategory == id, locale == language else { return }
      categoryAttributes = definitions.filter { $0.is_visible_on_front && $0.metadata?.status != "disabled" }.sorted { ($0.metadata?.display_order ?? 0) < ($1.metadata?.display_order ?? 0) }
      categoryFacets = page.facets ?? [:]
      var seen = Set(categoryProducts.map(\.id))
      categoryProducts += page.hits.filter { $0.active != false && seen.insert($0.id).inserted }
      categoryTotal = page.total
      categoryOffset += page.hits.count
      categoryHasMore = !page.hits.isEmpty && categoryOffset < page.total && categoryOffset <= 9999
    } catch {
      if categoryRequest == request { categoryError = copy("Unable to load products. Please retry.", "تعذر تحميل المنتجات. يرجى المحاولة.") }
    }
  }
  private var productRequest = UUID()
  public func dismissProduct() { productRequest = UUID(); selectedProduct = nil; variants = [] }
  public func product(_ id: String, family: ((String) async throws -> [Product])? = nil) async throws {
    let request = UUID(), language = locale
    // Keep the destination alive while replacing a parent with its variant.
    // Clearing the selection here dismisses SwiftUI's product navigation.
    productRequest = request; variants = []
    do {
      let value = try await catalog.product(id: id, locale: language)
      guard productRequest == request, locale == language, !Task.isCancelled else { throw CancellationError() }
      selectedProduct = value
      if value.productType != "simple", let family {
        let children = try await family(id)
        guard productRequest == request, locale == language, !Task.isCancelled else { throw CancellationError() }
        variants = children
      }
    } catch {
      guard productRequest == request, locale == language, !Task.isCancelled else { throw CancellationError() }
      throw error
    }
  }

  private var homeRequest = UUID()
  private enum HomeResult: Sendable {
    case categories([RocentoCore.Category])
    case products([Product])
    case collection(String, [Product])
  }
  public func load(collectionIDs: Set<String>) async throws {
    let request = UUID(), language = locale; homeRequest = request
    collections = collections.filter { collectionIDs.contains($0.key) }
    let provider = catalog
    // At most four independent reads; publish each section as it becomes ready.
    try await withThrowingTaskGroup(of: HomeResult.self) { group in
      group.addTask { .categories(try await provider.categories(locale: language)) }
      group.addTask { .products(try await provider.products(category: nil, locale: language)) }
      var remaining = collectionIDs.sorted().makeIterator()
      for _ in 0..<2 {
        if let id = remaining.next() { group.addTask { .collection(id, try await provider.products(category: id, locale: language)) } }
      }
      for try await result in group {
        guard homeRequest == request, locale == language, !Task.isCancelled else { throw CancellationError() }
        switch result {
        case .categories(let value): categories = value
        case .products(let value): products = value
        case .collection(let id, let value): collections[id] = value
        }
        if let id = remaining.next() { group.addTask { .collection(id, try await provider.products(category: id, locale: language)) } }
      }
    }
  }
  public func changeLocale(_ value: String) {
    guard value != locale else { return }
    closeCategory(); dismissProduct(); homeRequest = UUID(); locale = value
    products = []; categories = []; collections = [:]
  }
}
