import Foundation

public struct ComparisonProduct: Decodable, Identifiable, Sendable {
  public let id: String
  public let name: String
  public let description: String
  public let price: String
  public let currency: String
  public let in_stock: Bool
  public let product_type: String?
  public let active: Bool?
  public let unit: String?
  public let media_ids: [String]?
  public let attributes: [String: AssistantJSON]?
  public let catalog_offer: Product.Offer?
  public var displayPrice: String {
    guard let o = catalog_offer, o.product_id == id, o.currency == currency, let base = Decimal(string: price), let original = Decimal(string: o.original_price), let discount = Decimal(string: o.discounted_price), base == original, discount >= 0, discount < base else { return price }
    return o.discounted_price
  }
}
public struct ComparisonRow { public let label: String; public let values: [String] }
@MainActor public final class ComparisonStore {
  public private(set) var ids: [String] = []
  public private(set) var products: [ComparisonProduct] = []
  public private(set) var failed: [String] = []
  public private(set) var busy = false
  public var onChange: (() -> Void)?
  private var generation = 0
  public init() {}
  public func reset() { generation += 1; ids = []; products = []; failed = []; busy = false; onChange?() }
  public func toggle(_ value: String) {
    guard UUID(uuidString: value) != nil else { return }
    let id = value.lowercased()
    if ids.contains(id) { ids.removeAll { $0 == id } } else if ids.count < 5 { ids.append(id) }
    generation += 1; products = []; failed = []; busy = false; onChange?()
  }
  public var prompt: String { ids.count < 2 ? "" : "Compare these products: " + ids.map { "/products/" + $0 }.joined(separator: " ") }
  public func load(_ fetch: (String) async throws -> ComparisonProduct) async {
    generation += 1; let revision = generation; let selected = ids
    products = []; failed = []; busy = true; onChange?()
    defer { if revision == generation { busy = false; onChange?() } }
    for id in selected {
      do {
        let value = try await fetch(id)
        guard revision == generation, !Task.isCancelled else { return }
        if value.id == id && value.active != false { products.append(value) } else { failed.append(id) }
      } catch { guard revision == generation, !Task.isCancelled else { return }; failed.append(id) }
    }
  }
  public static func value(_ value: AssistantJSON?, locale: String) -> String {
    switch value {
    case .bool(let v): return locale == "ar" ? (v ? "نعم" : "لا") : (v ? "Yes" : "No")
    case .string(let v) where !v.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty: return v
    case .number(let v) where v.isFinite: return v.rounded() == v ? String(format: "%.0f", v) : String(v)
    default: return locale == "ar" ? "غير متوفر" : "Not provided"
    }
  }
  public func rows(locale: String) -> [ComparisonRow] {
    func t(_ en: String, _ ar: String) -> String { locale == "ar" ? ar : en }
    let keys = Set(products.flatMap { ($0.attributes ?? [:]).keys }).sorted()
    return [
      ComparisonRow(label: t("Price", "السعر"), values: products.map { ($0.product_type ?? "simple") == "simple" ? $0.displayPrice + " " + $0.currency : t("Choose options for pricing", "اختر الخيارات لمعرفة السعر") }),
      ComparisonRow(label: t("Selling unit", "وحدة البيع"), values: products.map { Self.value($0.unit.map(AssistantJSON.string), locale: locale) }),
      ComparisonRow(label: t("Availability", "التوفر"), values: products.map { ($0.product_type ?? "simple") != "simple" ? t("Choose options to check availability", "اختر الخيارات للتحقق من التوفر") : $0.in_stock ? t("In stock", "متوفر") : t("Out of stock", "غير متوفر") }),
      ComparisonRow(label: t("Description", "الوصف"), values: products.map { Self.value(.string($0.description), locale: locale) })
    ] + keys.map { key in ComparisonRow(label: key.replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: "-", with: " "), values: products.map { Self.value($0.attributes?[key], locale: locale) }) }
  }
}
