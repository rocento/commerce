package com.rocento.mobile

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class SecureSession(context: Context, identity: AppIdentity, purpose: String) : CredentialStorage {
    private val alias = "rocento-session-" + identity.cacheKey + "-" + purpose + "-" + digest(identity.commerceBase.toByteArray())
    private val preferences = context.getSharedPreferences(alias, Context.MODE_PRIVATE)

    private fun key(create: Boolean = true): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let {
            return it
        }
        check(create) { "Saved credential key is unavailable" }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
            .apply {
                init(
                    KeyGenParameterSpec.Builder(
                            alias,
                            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                        )
                        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                        .build(),
                )
            }
            .generateKey()
    }

    override fun read(): String? = runCatching { readChecked() }.getOrNull()

    override fun readChecked(): String? {
        val stored = preferences.getString("session", null) ?: return null
        val parts = stored.split(':')
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            key(create = false),
            GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)),
        )
        return String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), Charsets.UTF_8)
    }

    // KTX edit(commit = true) discards the result; credential durability must be checked.
    @android.annotation.SuppressLint("UseKtx")
    override fun save(value: String?) {
        if (value == null) {
            check(preferences.edit().clear().commit())
            return
        }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val data =
            Base64.encodeToString(cipher.iv, Base64.NO_WRAP) +
                ":" +
                Base64.encodeToString(cipher.doFinal(value.toByteArray()), Base64.NO_WRAP)
        check(preferences.edit().putString("session", data).commit())
    }
}
