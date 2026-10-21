package com.rocento.mobile

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Run login, force-stop the target process, then run restore (twice to check rotation).
 * Uses real Keystore storage under a synthetic identity and never accesses the network.
 */
@RunWith(AndroidJUnit4::class)
class CustomerRestartTests {
    @Test fun encryptedSessionAcrossProcesses() = runBlocking {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue(args.getString("customerRestart") == "true")
        val phase = args.getString("phase")
        require(phase in setOf("login", "restore", "restore_rotated", "cleanup"))
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val identity = AppIdentity(
            "00000000-0000-0000-0000-000000000099", "preview",
            "https://restart.example.test/api",
        )
        val credentials = SecureSession(context, identity, "restart-test-refresh")
        val attempts = SecureSession(context, identity, "restart-test-checkout")
        if (phase == "cleanup") {
            credentials.save(null)
            attempts.save(null)
            return@runBlocking
        }
        val first = "a".repeat(64)
        val rotated = "b".repeat(64)
        val transport = object : HTTPTransport {
            override suspend fun get(url: String, headers: Map<String,String>, maxBytes: Int): HTTPResult = error("Unexpected request")
            override suspend fun request(url: String, method: String, headers: Map<String,String>, body: String?, maxBytes: Int): HTTPResult {
                assertEquals("POST", method)
                assertNull(headers["Authorization"])
                if (phase == "login") {
                    assertEquals("https://restart.example.test/api/v1/customer/auth/login", url)
                    assertNull(headers["Cookie"])
                } else {
                    assertEquals("https://restart.example.test/api/v1/customer/auth/refresh", url)
                    assertEquals("customer_refresh=${if(phase == "restore") first else rotated}", headers["Cookie"])
                    assertNull(body)
                }
                return HTTPResult(200, mapOf("Set-Cookie" to "customer_refresh=${if(phase == "login") first else rotated}; Secure; HttpOnly"),
                    """{"customer":{"id":"00000000-0000-0000-0000-000000000099","primary_identifier":"email","email":"restart@example.test","verified":true},"access_token":"synthetic-access"}""".toByteArray())
            }
        }
        val client = CommerceClient(identity, credentials, attempts, transport)
        val customer = if(phase == "login") client.login("restart@example.test", "new-synthetic-password") else client.restore()
        assertEquals("restart@example.test", customer.identifier)
        assertTrue(customer.verified)
        assertEquals(if(phase == "login") first else rotated, credentials.read())
    }
}
