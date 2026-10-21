package com.rocento.mobile

/** Local guidance only; the service remains authoritative for account policy. */
object AccountForm {
    fun issue(mode: String, identifier: String, password: String, confirmation: String, code: String): String? {
        if (identifier.isBlank()) return "identifier"
        if (mode == "login" && password.isEmpty()) return "password"
        if (mode == "register" || mode == "reset-password") {
            if (password.toByteArray(Charsets.UTF_8).size !in 12..128) return "length"
            if (password != confirmation) return "confirmation"
        }
        if (mode in listOf("verify", "reset-password") && code.isBlank()) return "code"
        return null
    }
    fun next(mode: String) = when (mode) {
        "register" -> "verify"
        "forgot-password" -> "reset-password"
        "verify", "reset-password" -> "login"
        else -> mode
    }
}

/** Ephemeral; must never be saved to disk or saved-instance state. */
data class AuthenticationFormState(
    val mode: String = "login", val identifier: String = "", val password: String = "",
    val confirmation: String = "", val code: String = "", val showPassword: Boolean = false,
    val validation: String? = null, private val revision: String = java.util.UUID.randomUUID().toString(),
) {
    fun clearSecrets() = copy(password = "", confirmation = "", code = "", showPassword = false, validation = null, revision = java.util.UUID.randomUUID().toString())
    fun open(mode: String) = clearSecrets().copy(mode = mode)
    fun validate() = copy(validation = AccountForm.issue(mode, identifier, password, confirmation, code))
    fun complete(submitted: AuthenticationFormState) = if (this == submitted) open(AccountForm.next(submitted.mode)) else this
}
