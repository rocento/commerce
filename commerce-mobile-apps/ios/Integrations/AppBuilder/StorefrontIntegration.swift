import RocentoCore
import RocentoAppBuilder
import SwiftUI

/// Merchant apps use published settings with a validated local fallback.
@MainActor final class StorefrontIntegration: ObservableObject {
  let configuration: any StorefrontConfiguration
  let builder: AppBuilderConfiguration?
  #if DEBUG
  private let previewConfiguration: DraftPreviewConfiguration
  private let previewIdentity: AppBuilderIdentity
  #endif
  private let transport: any HTTPTransport
  #if DEBUG
  @Published var preview: DraftPreviewRuntime?
  private var previewTask: Task<Void, Never>?
  private var collectionsTask: Task<Void, Never>?
  #endif
  @Published var connecting = false
  @Published var message = ""
  init(identity: AppIdentity, fallback: Data, production: Bool,
       credentials: (String) -> any CredentialStorage, transport: any HTTPTransport) {
    self.transport = transport
    // Build-time override for local development workers; never accepted from a draft.
    let origin = Bundle.main.object(forInfoDictionaryKey: "RocentoBuilderOrigin") as? String ?? "https://grocery.rocento.com/api"
    let builderIdentity = try! AppBuilderIdentity(app: identity, configBaseURL: URL(string: origin)!)
    let adapter = AppBuilderConfiguration(
      identity: builderIdentity,
      identifier: Bundle.main.bundleIdentifier ?? "", storage: credentials("config-device"),
      directory: FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("mobile-config"), fallback: fallback, transport: transport)
    builder = adapter
    #if DEBUG
    previewIdentity = builderIdentity
    // Preview workers may opt out of published requests while using a draft capability.
    let published: any StorefrontConfiguration = ProcessInfo.processInfo.arguments.contains("-rocento-draft-preview")
      ? try! BundledConfiguration(identity: identity, data: fallback) : adapter
    previewConfiguration = DraftPreviewConfiguration(published: published)
    configuration = previewConfiguration
    #else
    configuration = adapter
    #endif
  }
  func activate(model: StorefrontModel) {
    #if DEBUG
    // Local acceptance workers inject a short-lived capability; never persist it.
    if let code = ProcessInfo.processInfo.environment["ROCENTO_PREVIEW_CODE"] {
      startPreview(code, model: model)
    }
    #endif
  }
  #if DEBUG
  func startPreview(_ code: String, model: StorefrontModel) {
    do {
      let channel = try HTTPDraftPreviewTransport(identity: previewIdentity, code: code, transport: transport)
      previewTask?.cancel()
      let runtime = DraftPreviewRuntime()
      preview = runtime
      previewTask = Task { [weak self, weak model, previewConfiguration] in
        await runtime.run(transport: channel) { snapshot in
          previewConfiguration.set(snapshot)
          model?.applyPresentation(snapshot)
          self?.collectionsTask?.cancel()
          self?.collectionsTask = Task { [weak model] in try? await model?.refreshPresentationCollections() }
        }
      }
    } catch { message = "Invalid preview session code." }
  }
  func stopPreview(model: StorefrontModel) {
    previewTask?.cancel(); previewTask = nil; preview = nil
    collectionsTask?.cancel(); collectionsTask = nil
    previewConfiguration.set(nil)
    Task { await model.load() }
  }
  #endif
  func connect(_ code: String, model: StorefrontModel) async {
    guard !connecting, let builder else { return }
    connecting = true
    message = ""
    defer { connecting = false }
    do {
      try await builder.enrollment.enroll(code: code)
      await model.load()
      message = model.copy("App connected. Pull to refresh published updates.", "تم ربط التطبيق. اسحب لتحديث التصميم المنشور.")
    } catch is CancellationError { return }
    catch { message = model.copy("Unable to connect. Check the code or request a new one.", "تعذر الربط. تحقق من الرمز أو اطلب رمزاً جديداً.") }
  }
}

struct StorefrontSettings: View {
  @ObservedObject var model: StorefrontModel
  @ObservedObject var integration: StorefrontIntegration
  @State private var code = ""
  #if DEBUG
  @State private var previewCode = ""
  #endif
  init(model: StorefrontModel) { self.model = model; integration = model.integration }
  var body: some View {
    #if DEBUG
    DisclosureGroup(model.copy("Live native preview", "المعاينة الأصلية المباشرة")) {
      Text(model.copy("Paste the short-lived session code from Apps Builder. Saved drafts update this SwiftUI app automatically.", "الصق رمز جلسة المعاينة من منشئ التطبيقات لتحديث تطبيق SwiftUI تلقائياً."))
      SecureField(model.copy("Preview session code", "رمز جلسة المعاينة"), text: $previewCode)
        .textInputAutocapitalization(.never).autocorrectionDisabled()
        .accessibilityIdentifier("preview-session-code")
      Button(model.copy("Start native preview", "بدء المعاينة الأصلية")) {
        let value = previewCode; previewCode = ""
        integration.startPreview(value, model: model)
      }.disabled(previewCode.isEmpty).accessibilityIdentifier("preview-session-start")
      if !integration.message.isEmpty { Text(integration.message) }
      if let runtime = integration.preview {
        NativePreviewStatus(runtime: runtime)
        Button(model.copy("Stop native preview", "إيقاف المعاينة الأصلية")) { integration.stopPreview(model: model) }
      }
    }
    #endif
    if integration.builder != nil {
      DisclosureGroup(model.copy("App connection", "ربط التطبيق")) {
        Text(model.copy("Published design version", "إصدار التصميم المنشور") + " \(model.config?.configVersion ?? 0)")
        SecureField(model.copy("One-time connection code", "رمز الربط لمرة واحدة"), text: $code)
          .textInputAutocapitalization(.never).autocorrectionDisabled()
          .accessibilityIdentifier("enrollment-code")
        Button(model.copy("Connect app", "ربط التطبيق")) {
          let value = code
          code = ""
          Task { await integration.connect(value, model: model) }
        }.disabled(integration.connecting || code.trimmingCharacters(in: .whitespacesAndNewlines).count != 64)
          .accessibilityIdentifier("enrollment-connect")
        if !integration.message.isEmpty { Text(integration.message) }
      }
    }
  }
}

#if DEBUG
private struct NativePreviewStatus: View {
  @ObservedObject var runtime: DraftPreviewRuntime
  var body: some View { Text(runtime.status).accessibilityIdentifier("preview-session-status") }
}

func verifyUpgradeConfiguration(identity: AppIdentity, phase: String) async throws {
  let storage = SecureSession(identity: identity, purpose: "config-device")
  let transport = UpgradeConfigurationTransport(identity: identity)
  let adapterIdentity = try AppBuilderIdentity(app: identity, configBaseURL: URL(string: "https://configuration-upgrade.example.test/api")!)
  let adapter = AppBuilderConfiguration(identity: adapterIdentity, identifier: "com.rocento.grocery",
    storage: storage, directory: FileManager.default.temporaryDirectory.appendingPathComponent("keychain-upgrade-config"),
    fallback: try Bundled.data("merchant-1"), transport: transport)
  if phase == "seed" {
    try KeychainUpgradeAcceptance.require(try storage.readChecked() == nil)
    try await adapter.enrollment.enroll(code: String(repeating: "c", count: 64))
  }
  try KeychainUpgradeAcceptance.require(try storage.readChecked() == String(repeating: "d", count: 64))
  let snapshot = try await adapter.refresh(locale: "en")
  try KeychainUpgradeAcceptance.require(snapshot.source == "network" && snapshot.config.configVersion == 42)
  try await transport.verify(seed: phase == "seed")
}

private actor UpgradeConfigurationTransport: HTTPTransport {
  let identity: AppIdentity
  var enrollmentCount = 0
  var sessionCount = 0
  var configCount = 0
  init(identity: AppIdentity) { self.identity = identity }
  func verify(seed: Bool) throws {
    try KeychainUpgradeAcceptance.require(enrollmentCount == (seed ? 1 : 0) && sessionCount == (seed ? 0 : 1) && configCount == 1)
  }
  func get(_ request: URLRequest, maxBytes: Int) async throws -> HTTPResult {
    try KeychainUpgradeAcceptance.require(request.url?.host == "configuration-upgrade.example.test" && request.value(forHTTPHeaderField: "Cookie") == nil)
    let path = request.url!.path
    if path.hasSuffix("/session") || path.hasSuffix("/enroll") {
      let seed = path.hasSuffix("/enroll")
      let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: String]
      try KeychainUpgradeAcceptance.require(body[seed ? "code" : "deviceToken"] == String(repeating: seed ? "c" : "d", count: 64))
      if seed { enrollmentCount += 1 } else { sessionCount += 1 }
      var value: [String: Any] = ["deviceId": "90000000-0000-0000-0000-000000000003",
        "accessToken": String(repeating: "e", count: 64), "expiresIn": 1800,
        "merchantId": identity.merchantID, "platform": "ios", "identifier": "com.rocento.grocery", "environment": identity.environment]
      if seed { value["deviceToken"] = String(repeating: "d", count: 64) }
      return HTTPResult(status: 200, body: try JSONSerialization.data(withJSONObject: value))
    }
    if path.hasSuffix("/config") {
      try KeychainUpgradeAcceptance.require(request.value(forHTTPHeaderField: "Authorization") == "Bearer " + String(repeating: "e", count: 64))
      configCount += 1
      var value = try JSONSerialization.jsonObject(with: Bundled.data("merchant-1")) as! [String: Any]
      value["configVersion"] = 42
      let body = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
      let hash = ConfigValidation.digest(body)
      return HTTPResult(status: 200, headers: ["ETag": "\"mobile-\(hash)\"", "X-Config-Checksum": hash], body: body)
    }
    // Optional artwork falls back locally; it cannot hit a network.
    return HTTPResult(status: 404)
  }
}
#endif
