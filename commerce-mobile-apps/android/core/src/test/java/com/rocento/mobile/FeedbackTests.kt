package com.rocento.mobile

import kotlinx.coroutines.*
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

class FeedbackTests {
    @Test fun errorClassificationAndSafeFallback() {
        val kinds=mapOf(422 to FailureKind.Validation,401 to FailureKind.Authentication,403 to FailureKind.Permission,409 to FailureKind.Conflict,429 to FailureKind.RateLimit,503 to FailureKind.Server)
        kinds.forEach { (status,kind) -> assertEquals(AppFailure(kind,"safe",status),AppFailure.map(CommerceFailure(status,"safe"))) }
        assertFalse(AppFailure.map(IllegalStateException("private diagnostic"))!!.message.contains("private"))
        assertEquals("تعذر الاتصال. تحقق من اتصالك وحاول مرة أخرى.",AppFailure.map(java.io.IOException(),"ar")?.message)
        assertNull(AppFailure.map(CancellationException()))
    }
    @Test fun authenticationFailureSurvivesResetWithoutRetry() = runTest {
        val feedback=FeedbackStore();val queue=OperationCoordinator();var calls=0;var resets=0
        val result=feedback.perform(queue,onUnauthorized={resets++;feedback.clear()}) { calls++;throw CommerceFailure(401,"Sign in") }
        assertFalse(result);assertEquals(1,calls);assertEquals(1,resets);assertEquals(FailureKind.Authentication,feedback.state.value.failure?.kind);assertFalse(queue.busy)
    }
    @Test fun confirmationSurvivesFollowupFailureAndCanBeDismissedSeparately() = runTest {
        val feedback=FeedbackStore();val queue=OperationCoordinator()
        feedback.perform(queue) { feedback.setNotice("Order confirmed");throw CommerceFailure(503,"History unavailable") }
        assertEquals("Order confirmed",feedback.state.value.notice);assertEquals(FailureKind.Server,feedback.state.value.failure?.kind)
        feedback.setError(null);assertNull(feedback.state.value.failure);assertEquals("Order confirmed",feedback.state.value.notice)
        feedback.setNotice(null);assertNull(feedback.state.value.notice)
        feedback.perform(queue,onUnauthorized={feedback.clear()}) { feedback.setNotice("Order confirmed");throw CommerceFailure(401,"Sign in") }
        assertEquals("Order confirmed",feedback.state.value.notice);assertEquals(FailureKind.Authentication,feedback.state.value.failure?.kind)
    }
    @Test fun queuedWorkPreservesFeedbackUntilStartAndTracksKind() = runTest {
        val feedback=FeedbackStore();val queue=OperationCoordinator();val gate=CompletableDeferred<Unit>()
        val active=async(start=CoroutineStart.UNDISPATCHED){feedback.perform(queue,OperationKind.Refresh) { feedback.setNotice("Refreshing");gate.await() }}
        val next=async(start=CoroutineStart.UNDISPATCHED){feedback.perform(queue) { assertNull(feedback.state.value.notice);assertEquals(OperationKind.Mutation,queue.loading.value.kind) }}
        assertEquals("Refreshing",feedback.state.value.notice);assertEquals(OperationLoadingState(true,1,OperationKind.Refresh),queue.loading.value)
        gate.complete(Unit);active.await();next.await();assertEquals(OperationLoadingState(),queue.loading.value)
    }
    @Test fun invalidatedQueueNeverRunsOrClearsCurrentFeedback() = runTest {
        val feedback=FeedbackStore();val queue=OperationCoordinator();val gate=CompletableDeferred<Unit>();var calls=0
        val active=async(start=CoroutineStart.UNDISPATCHED){feedback.perform(queue,OperationKind.Initial) { gate.await();feedback.setNotice("Finished") }}
        val next=async(start=CoroutineStart.UNDISPATCHED){feedback.perform(queue) { calls++ }}
        queue.invalidatePending();gate.complete(Unit);active.await()
        try {next.await();fail()}catch(_:CancellationException){}
        assertEquals(0,calls);assertEquals(FeedbackState(notice="Finished"),feedback.state.value);assertFalse(queue.busy)
    }
    @Test fun cancellationPropagatesWithoutFeedbackAndLoadingAlwaysSettles() = runTest {
        val feedback=FeedbackStore();val queue=OperationCoordinator();feedback.setError("old");feedback.setNotice("old")
        try {feedback.perform(queue) { throw CancellationException() };fail()}catch(_:CancellationException){}
        assertEquals(FeedbackState(),feedback.state.value);assertEquals(OperationLoadingState(),queue.loading.value)
    }
}
