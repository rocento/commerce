import XCTest
@testable import RocentoCore

final class AccountFormTests: XCTestCase {
  func testPasswordPolicyUsesBytesWithoutTrimmingSecrets() {
    XCTAssertNil(AccountForm.issue(mode: "register", identifier: "a@example.test", password: "عععععع", confirmation: "عععععع", code: ""))
    XCTAssertEqual(AccountForm.issue(mode: "register", identifier: "a@example.test", password: String(repeating: "ع", count: 65), confirmation: "", code: ""), "length")
    XCTAssertEqual(AccountForm.issue(mode: "register", identifier: "a@example.test", password: "long password ", confirmation: "long password", code: ""), "confirmation")
  }
  func testRecoveryAndVerificationRequirements() {
    XCTAssertNil(AccountForm.issue(mode: "forgot-password", identifier: "a@example.test", password: "", confirmation: "", code: ""))
    XCTAssertEqual(AccountForm.issue(mode: "verify", identifier: "a@example.test", password: "", confirmation: "", code: "  "), "code")
    XCTAssertEqual(AccountForm.issue(mode: "reset-password", identifier: "a@example.test", password: "long password", confirmation: "long password", code: ""), "code")
    XCTAssertEqual(AccountForm.issue(mode: "login", identifier: " \n", password: "secret", confirmation: "", code: ""), "identifier")
    XCTAssertNil(AccountForm.issue(mode: "login", identifier: "a@example.test", password: "legacy", confirmation: "", code: ""))
  }
  func testSuccessfulStepsReturnToSignIn() {
    XCTAssertEqual(AccountForm.next("register"), "verify")
    XCTAssertEqual(AccountForm.next("forgot-password"), "reset-password")
    XCTAssertEqual(AccountForm.next("verify"), "login")
    XCTAssertEqual(AccountForm.next("reset-password"), "login")
  }
}
