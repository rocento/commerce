package com.rocento.mobile
import org.junit.Assert.*
import org.junit.Test
import kotlinx.coroutines.runBlocking

class AuthSettingsTests {
    @Test fun completionClearsSecretsAndPreservesIdentifier() {
        val form = AuthenticationFormState(mode="register",identifier="person",password="long password",confirmation="long password",showPassword=true).validate()
        assertNull(form.validation)
        val next = form.complete(form)
        assertEquals("verify",next.mode); assertEquals("person",next.identifier)
        assertEquals("",next.password); assertEquals("",next.confirmation); assertFalse(next.showPassword)
    }
    @Test fun dismissOrEditRejectsLateCompletion() {
        val form = AuthenticationFormState(mode="forgot-password",identifier="person")
        val closed = form.clearSecrets()
        assertEquals(closed,closed.complete(form))
        val edited = form.copy(identifier="other")
        assertEquals(edited,edited.complete(form))
    }
    @Test fun settingsPersistAndRejectFailedConsent() = runBlocking {
        val saved = mutableListOf<String>()
        val settings = AppSettingsStore("bad",saveLocale={saved.add(it)})
        assertEquals("en",settings.state.value.locale)
        settings.selectLocale("ar"); settings.selectLocale("ar"); settings.selectLocale("bad")
        assertEquals(listOf("ar"),saved)
        try { settings.consent(true) { error("offline") }; fail() } catch (_: IllegalStateException) {}
        assertFalse(settings.state.value.analyticsEnabled)
        settings.consent(true) {}
        assertTrue(settings.state.value.analyticsEnabled); assertEquals("ar",settings.state.value.locale)
    }
}
