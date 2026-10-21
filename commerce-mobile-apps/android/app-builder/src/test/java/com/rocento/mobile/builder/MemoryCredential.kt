package com.rocento.mobile.builder
import com.rocento.mobile.CredentialStorage
class MemoryCredential(var value: String? = null) : CredentialStorage {
    override fun read() = value
    override fun save(value: String?) { this.value = value }
}
