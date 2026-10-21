package com.rocento.mobile

import com.rocento.mobile.contract.MobileConfig

data class ConfigSnapshot(
    val config: MobileConfig,
    val source: String,
    val assets: Map<String, ByteArray> = emptyMap(),
)

/** Presentation input; commerce has no dependency on its source. */
interface StorefrontConfiguration {
    suspend fun refresh(locale: String): ConfigSnapshot
}

/** No network, enrollment, or persisted remote design can affect this provider. */
class BundledConfiguration(identity: AppIdentity, data: ByteArray, validator: ConfigValidator,
                           assets: Map<String, ByteArray> = emptyMap()) : StorefrontConfiguration {
    val snapshot = ConfigSnapshot(validator.decode(data, identity, true), "bundled", assets)
    override suspend fun refresh(locale: String) = snapshot
}
