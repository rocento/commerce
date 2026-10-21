package com.rocento.mobile

import org.junit.Assert.*
import org.junit.Test

class AccountFormTests {
    @Test fun passwordPolicyUsesBytesWithoutTrimmingSecrets() {
        assertNull(AccountForm.issue("register", "a@example.test", "عععععع", "عععععع", ""))
        assertEquals("length", AccountForm.issue("register", "a@example.test", "ع".repeat(65), "", ""))
        assertEquals("confirmation", AccountForm.issue("register", "a@example.test", "long password ", "long password", ""))
    }
    @Test fun recoveryAndVerificationRequirements() {
        assertNull(AccountForm.issue("forgot-password", "a@example.test", "", "", ""))
        assertEquals("code", AccountForm.issue("verify", "a@example.test", "", "", "  "))
        assertEquals("code", AccountForm.issue("reset-password", "a@example.test", "long password", "long password", ""))
        assertEquals("identifier", AccountForm.issue("login", " \n", "secret", "", ""))
        assertNull(AccountForm.issue("login", "a@example.test", "legacy", "", ""))
    }
    @Test fun successfulStepsReturnToSignIn() {
        assertEquals("verify", AccountForm.next("register"))
        assertEquals("reset-password", AccountForm.next("forgot-password"))
        assertEquals("login", AccountForm.next("verify"))
        assertEquals("login", AccountForm.next("reset-password"))
    }
}
