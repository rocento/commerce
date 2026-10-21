import CoreFoundation
import CryptoKit
import Foundation

public enum MobileFailure: Error {
  case invalidConfig, wrongMerchant, incompatible, invalidEndpoint, invalidResponse, unauthorized
}
public struct AppIdentity: Sendable {
  public let merchantID: String
  public let environment: String
  public let commerceBaseURL: URL
  public let runtimeVersion: String
  public init(
    merchantID: String, environment: String, commerceBaseURL: URL,
    runtimeVersion: String = "1.3.0"
  ) throws {
    guard UUID(uuidString: merchantID) != nil, ConfigValidation.version(runtimeVersion) != nil,
      ["staging", "production", "preview"].contains(environment),
      Self.safe(commerceBaseURL)
    else { throw MobileFailure.invalidEndpoint }
    self.merchantID = merchantID
    self.environment = environment
    self.commerceBaseURL = commerceBaseURL
    self.runtimeVersion = runtimeVersion
  }
  public static func safe(_ url: URL) -> Bool {
    url.scheme == "https" && url.host != nil && url.user == nil && url.password == nil
      && url.query == nil && url.fragment == nil && ["", "/", "/api", "/api/"].contains(url.path)
  }
  public var cacheKey: String {
    ConfigValidation.digest(
      Data("\(merchantID)|\(environment)|ios|\(commerceBaseURL.absoluteString)".utf8))
  }
}
public enum Bundled {
  public static func asset(_ id: String) -> Data? {
    guard UUID(uuidString: id) != nil, let url = Bundle.module.url(forResource: id, withExtension: "asset") else { return nil }; return try? Data(contentsOf: url)
  }
  public static func data(_ name: String) throws -> Data {
    guard let url = Bundle.module.url(forResource: name, withExtension: "json") else {
      throw MobileFailure.invalidConfig
    }
    return try Data(contentsOf: url)
  }
}
// Evaluates only the closed keyword subset emitted by generate_contract.py.
// The generator rejects new keywords until both native validators support them.
enum ContractShape {
  static func check(_ value: Any, _ schema: [String: Any], root: [String: Any]) throws {
    func fail() throws -> Never { throw MobileFailure.invalidConfig }
    if let ref = schema["$ref"] as? String {
      guard ref.hasPrefix("#/$defs/"), let defs = root["$defs"] as? [String: [String: Any]],
        let target = defs[String(ref.dropFirst(8))]
      else { try fail() }
      try check(value, target, root: root)
      return
    }
    if let branches = schema["oneOf"] as? [[String: Any]] {
      guard branches.filter({ (try? check(value, $0, root: root)) != nil }).count == 1 else {
        try fail()
      }
      return
    }
    if let choices = schema["enum"] as? [String], let text = value as? String,
      !choices.contains(text)
    {
      try fail()
    }
    switch schema["type"] as? String {
    case "object":
      guard let object = value as? [String: Any] else { try fail() }
      let props = schema["properties"] as? [String: [String: Any]] ?? [:]
      for key in schema["required"] as? [String] ?? [] { if object[key] == nil { try fail() } }
      if let min = schema["minProperties"] as? Int, object.count < min { try fail() }
      if let max = schema["maxProperties"] as? Int, object.count > max { try fail() }
      for (key, child) in object {
        if let names = schema["propertyNames"] as? [String: Any] {
          try check(key, names, root: root)
        }
        if let rule = props[key] {
          try check(child, rule, root: root)
        } else if let rule = schema["additionalProperties"] as? [String: Any] {
          try check(child, rule, root: root)
        } else if schema["additionalProperties"] as? Bool == false {
          try fail()
        }
      }
    case "array":
      guard let values = value as? [Any], let rule = schema["items"] as? [String: Any] else {
        try fail()
      }
      if let min = schema["minItems"] as? Int, values.count < min { try fail() }
      if let max = schema["maxItems"] as? Int, values.count > max { try fail() }
      if schema["uniqueItems"] as? Bool == true {
        let encoded = try values.map {
          try JSONSerialization.data(withJSONObject: $0, options: [.fragmentsAllowed, .sortedKeys])
        }
        if Set(encoded).count != values.count { try fail() }
      }
      for child in values { try check(child, rule, root: root) }
    case "string":
      guard let text = value as? String else { try fail() }
      if let min = schema["minLength"] as? Int, text.unicodeScalars.count < min { try fail() }
      if let max = schema["maxLength"] as? Int, text.unicodeScalars.count > max { try fail() }
      if let pattern = schema["pattern"] as? String,
        text.range(of: pattern, options: .regularExpression) == nil
      {
        try fail()
      }
    case "integer":
      guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(),
        n.doubleValue.isFinite, n.doubleValue.rounded() == n.doubleValue
      else { try fail() }
      if let min = schema["minimum"] as? Double, n.doubleValue < min { try fail() }
      if let max = schema["maximum"] as? Double, n.doubleValue > max { try fail() }
    case "boolean":
      guard let n = value as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { try fail() }
    default: try fail()
    }
  }
}
public enum ConfigValidation {
  public static func digest(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }
  public static func decode(_ data: Data, identity: AppIdentity, bundled: Bool = false) throws
    -> MobileConfig
  {
    guard data.count <= 131_072 else { throw MobileFailure.invalidConfig }
    let schema = try JSONSerialization.jsonObject(with: Bundled.data("schema")) as! [String: Any]
    try ContractShape.check(JSONSerialization.jsonObject(with: data), schema, root: schema)
    let config = try JSONDecoder().decode(MobileConfig.self, from: data)
    guard config.tenantId == identity.merchantID else { throw MobileFailure.wrongMerchant }
    guard bundled || config.configVersion > 0 else { throw MobileFailure.invalidConfig }
    guard let minimum = version(config.compatibility.minIosRuntime),
      let current = version(identity.runtimeVersion), minimum[0] == 1, current[0] == 1,
      !current.lexicographicallyPrecedes(minimum)
    else { throw MobileFailure.incompatible }
    let raw = try JSONSerialization.jsonObject(with: data) as! [String: Any]
    let home = (raw["screens"] as? [String: Any])?["home"] as? [String: Any] ?? [:]
    let banners = (home["sections"] as? [[String: Any]] ?? []).contains { section in
      let props = section["props"] as? [String: Any] ?? [:]
      return ["layout", "imageFit", "additionalImageAssetIds"].contains { props[$0] != nil }
    }
    if banners && (current.lexicographicallyPrecedes([1, 3, 0]) || minimum.lexicographicallyPrecedes([1, 3, 0])) { throw MobileFailure.incompatible }
    let editorial = home["layout"] != nil || (home["sections"] as? [[String: Any]] ?? []).contains { section in
      let props = section["props"] as? [String: Any] ?? [:]
      return ["headingKey", "bodyKey", "eyebrowKey", "labelKey", "appearance", "limit", "storefrontPath"].contains { props[$0] != nil } || (props["collectionId"] as? String)?.hasPrefix("demo-feed-") == true
    }
    if editorial && (current.lexicographicallyPrecedes([1, 2, 0]) || minimum.lexicographicallyPrecedes([1, 2, 0])) { throw MobileFailure.incompatible }
    let navigation = raw["navigation"] as? [String: Any] ?? [:]
    let deals = (navigation["tabs"] as? [String] ?? []).contains("deals")
      || (navigation["icons"] as? [String: String] ?? [:]).values.contains("deals")
      || (home["sections"] as? [[String: Any]] ?? []).contains { section in
        ((section["props"] as? [String: Any])?["action"] as? [String: Any])?["tab"] as? String == "deals"
      }
    if deals && (current.lexicographicallyPrecedes([1, 2, 0]) || minimum.lexicographicallyPrecedes([1, 2, 0])) { throw MobileFailure.incompatible }
    for p in [config.brand.light, config.brand.dark] {
      for (a, b) in [(p.onPrimary, p.primary), (p.text, p.background), (p.text, p.surface)] {
        guard contrast(a, b) >= 4.5 else { throw MobileFailure.invalidConfig }
      }
    }
    let tabs = config.navigation.tabs.map(\.rawValue)
    guard ["home", "cart", "account"].allSatisfy(tabs.contains),
      !tabs.contains("wishlist") || config.features.wishlist
    else { throw MobileFailure.invalidConfig }
    let locales = config.localization.supportedLocales.map(\.rawValue)
    guard locales.contains(config.localization.defaultLocale.rawValue),
      !locales.contains("ar") || config.localization.rtlEnabled
    else { throw MobileFailure.invalidConfig }
    var ids = Set<String>()
    for section in config.screens.home.sections {
      guard ids.insert(section.id).inserted else { throw MobileFailure.invalidConfig }
      for locale in locales {
        for key in section.messageKeys {
          guard config.messages(locale)[key] != nil else { throw MobileFailure.invalidConfig }
        }
      }
      if case .richText(let text) = section, let destination = text.props.action, case .openTab(let action) = destination {
        guard tabs.contains(action.tab.rawValue) else { throw MobileFailure.invalidConfig }
      }
      if case .heroBanner(let hero) = section, case .openTab(let action) = hero.props.action {
        guard tabs.contains(action.tab.rawValue) else { throw MobileFailure.invalidConfig }
      }
    }
    return config
  }
  static func version(_ text: String) -> [Int]? {
    guard
      text.range(
        of: "^(0|[1-9][0-9]{0,5})\\.(0|[1-9][0-9]{0,5})\\.(0|[1-9][0-9]{0,5})$",
        options: .regularExpression) != nil
    else { return nil }
    return text.split(separator: ".").compactMap { Int($0) }
  }
  static func contrast(_ a: String, _ b: String) -> Double {
    func luminance(_ color: String) -> Double {
      let rgb = UInt32(color.dropFirst(), radix: 16)!
      let channels: [Double] = [16, 8, 0].map { shift in Double((rgb >> shift) & 255) / 255.0 }
      let values: [Double] = channels.map { c in
        c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
      }
      return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722
    }
    let x = luminance(a)
    let y = luminance(b)
    return (max(x, y) + 0.05) / (min(x, y) + 0.05)
  }
}
extension MobileConfig {
  public func locale(_ requested: String) -> String {
    localization.supportedLocales.map(\.rawValue).contains(requested)
      ? requested : localization.defaultLocale.rawValue
  }
  public func messages(_ locale: String) -> [String: String] {
    locale == "ar" ? localization.messages.ar ?? [:] : localization.messages.en ?? [:]
  }
  public func text(_ key: String, locale: String) -> String {
    messages(self.locale(locale))[key] ?? messages(localization.defaultLocale.rawValue)[key] ?? key
  }
}
extension Section {
  public var id: String {
    switch self {
    case .heroBanner(let v): return v.id
    case .productCarousel(let v): return v.id
    case .productGrid(let v): return v.id
    case .categoryGrid(let v): return v.id
    case .richText(let v): return v.id
    case .spacer(let v): return v.id
    }
  }
  public var messageKeys: [String] {
    switch self {
    case .heroBanner(let v): return [v.props.accessibilityLabelKey] + [v.props.headingKey, v.props.bodyKey, v.props.eyebrowKey, v.props.labelKey].compactMap { $0 }
    case .productCarousel(let v): return [v.props.titleKey]
    case .productGrid(let v): return [v.props.titleKey]
    case .categoryGrid(let v): return [v.props.titleKey]
    case .richText(let v): return [v.props.textKey] + [v.props.headingKey, v.props.bodyKey, v.props.eyebrowKey, v.props.labelKey].compactMap { $0 }
    case .spacer: return []
    }
  }
}
