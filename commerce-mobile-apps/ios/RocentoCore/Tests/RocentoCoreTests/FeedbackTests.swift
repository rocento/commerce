import XCTest
@testable import RocentoCore

private actor FeedbackGate {
  private var continuation: CheckedContinuation<Void, Never>?
  func wait(_ started: XCTestExpectation) async { await withCheckedContinuation { continuation = $0; started.fulfill() } }
  func release() { continuation?.resume(); continuation = nil }
}
final class FeedbackTests: XCTestCase {
  func testClassificationAndSafeFallback() {
    let kinds: [Int: FailureKind] = [422: .validation, 401: .authentication, 403: .permission, 409: .conflict, 429: .rateLimit, 503: .server]
    for (status,kind) in kinds { XCTAssertEqual(AppFailure.map(CommerceFailure(status,"safe")),AppFailure(kind: kind,message: "safe",status: status)) }
    XCTAssertNil(AppFailure.map(CancellationError())); XCTAssertNil(AppFailure.map(URLError(.cancelled)))
    XCTAssertEqual(AppFailure.map(URLError(.notConnectedToInternet),locale: "ar")?.message,"تعذر الاتصال. تحقق من اتصالك وحاول مرة أخرى.")
    XCTAssertFalse(AppFailure.map(NSError(domain: "private diagnostic",code: 1))!.message.contains("private"))
  }
  @MainActor func testAuthenticationFailureSurvivesResetWithoutRetry() async {
    let feedback = FeedbackStore(), queue = OperationCoordinator(); var calls = 0; var resets = 0
    let result = await feedback.perform(using: queue,onUnauthorized: { resets += 1; feedback.clear() }) { calls += 1; throw CommerceFailure(401,"Sign in") }
    XCTAssertFalse(result); XCTAssertEqual(calls,1); XCTAssertEqual(resets,1); XCTAssertEqual(feedback.failure?.kind,.authentication); XCTAssertFalse(queue.busy)
  }
  @MainActor func testConfirmationSurvivesFollowupFailureAndSeparateDismissal() async {
    let feedback = FeedbackStore(), queue = OperationCoordinator()
    await feedback.perform(using: queue) { feedback.setNotice("Order confirmed"); throw CommerceFailure(503,"History unavailable") }
    XCTAssertEqual(feedback.notice,"Order confirmed"); XCTAssertEqual(feedback.failure?.kind,.server)
    feedback.setError(nil); XCTAssertNil(feedback.failure); XCTAssertEqual(feedback.notice,"Order confirmed")
    feedback.setNotice(nil); XCTAssertNil(feedback.notice)
    await feedback.perform(using: queue, onUnauthorized: { feedback.clear() }) { feedback.setNotice("Order confirmed"); throw CommerceFailure(401,"Sign in") }
    XCTAssertEqual(feedback.notice,"Order confirmed"); XCTAssertEqual(feedback.failure?.kind,.authentication)
  }
  @MainActor func testQueuePreservesFeedbackUntilStartAndTracksKind() async {
    let feedback = FeedbackStore(), queue = OperationCoordinator(), gate = FeedbackGate(); let started = expectation(description: "active")
    let active = Task { await feedback.perform(using: queue,kind: .refresh) { feedback.setNotice("Refreshing"); await gate.wait(started) } }
    await fulfillment(of: [started])
    let next = Task { await feedback.perform(using: queue) { XCTAssertNil(feedback.notice); XCTAssertEqual(queue.loading.kind,.mutation) } }
    for _ in 0..<100 { if queue.pendingCount == 1 { break }; await Task.yield() }
    XCTAssertEqual(feedback.notice,"Refreshing"); XCTAssertEqual(queue.loading,OperationLoadingState(active: true,queued: 1,kind: .refresh))
    await gate.release(); _ = await active.value; _ = await next.value
    XCTAssertEqual(queue.loading,OperationLoadingState(active: false,queued: 0,kind: nil))
  }
  @MainActor func testInvalidatedQueueDoesNotRunOrClearFeedback() async {
    let feedback = FeedbackStore(), queue = OperationCoordinator(), gate = FeedbackGate(); let started = expectation(description: "active"); var calls = 0
    let active = Task { await feedback.perform(using: queue,kind: .initial) { await gate.wait(started); feedback.setNotice("Finished") } }
    await fulfillment(of: [started])
    let next = Task { await feedback.perform(using: queue) { calls += 1 } }
    for _ in 0..<100 { if queue.pendingCount == 1 { break }; await Task.yield() }
    queue.invalidatePending(); await gate.release(); _ = await active.value; let result = await next.value
    XCTAssertFalse(result); XCTAssertEqual(calls,0); XCTAssertEqual(feedback.notice,"Finished"); XCTAssertNil(feedback.failure); XCTAssertFalse(queue.busy)
  }
  @MainActor func testCancellationStaysSilentAndSettlesLoading() async {
    let feedback = FeedbackStore(), queue = OperationCoordinator(); feedback.setError("old"); feedback.setNotice("old")
    let result = await feedback.perform(using: queue) { throw CancellationError() }
    XCTAssertFalse(result); XCTAssertNil(feedback.failure); XCTAssertNil(feedback.notice); XCTAssertFalse(queue.busy)
  }
}
