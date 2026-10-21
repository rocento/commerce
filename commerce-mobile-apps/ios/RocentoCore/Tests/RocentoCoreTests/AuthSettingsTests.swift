import XCTest
@testable import RocentoCore

final class AuthSettingsTests: XCTestCase {
  func testCompletionClearsSecretsAndPreservesIdentifier() {
    var form = AuthenticationFormState()
    form.open("register"); form.identifier = "person@example.test"
    form.password = "long password"; form.confirmation = form.password; form.showPassword = true
    XCTAssertTrue(form.validate())
    XCTAssertTrue(form.complete(form))
    XCTAssertEqual(form.mode, "verify"); XCTAssertEqual(form.identifier, "person@example.test")
    XCTAssertEqual(form.password, ""); XCTAssertEqual(form.confirmation, ""); XCTAssertFalse(form.showPassword)
  }
  func testDismissOrEditRejectsLateCompletion() {
    var form = AuthenticationFormState(); form.open("forgot-password"); form.identifier = "person"
    let submitted = form
    form.clearSecrets()
    XCTAssertFalse(form.complete(submitted))
    let next = form; form.identifier = "other"
    XCTAssertFalse(form.complete(next)); XCTAssertEqual(form.mode, "forgot-password")
  }
  @MainActor func testSettingsPersistAndRejectFailedConsent() async throws {
    var saved: [String] = []
    let settings = AppSettingsStore(locale: "unsupported", saveLocale: { saved.append($0) })
    XCTAssertEqual(settings.locale, "en")
    settings.selectLocale("ar"); settings.selectLocale("ar"); settings.selectLocale("bad")
    XCTAssertEqual(saved, ["ar"])
    struct Failure: Error {}
    do { try await settings.consent(true) { _ in throw Failure() }; XCTFail() } catch {}
    XCTAssertFalse(settings.analyticsEnabled)
    try await settings.consent(true) { _ in }
    XCTAssertTrue(settings.analyticsEnabled); XCTAssertEqual(settings.locale, "ar")
  }
}
