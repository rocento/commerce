package com.rocento.mobile

import kotlinx.coroutines.CoroutineScope

/** Composition root; the app supplies its lifecycle scope and platform persistence. */
class ShoppingRuntime(
    val client: CommerceClient,
    val settings: AppSettingsStore,
    scope: CoroutineScope,
    catalog: CatalogServing = client,
    notificationPreferences: NotificationPreferences = MemoryNotificationPreferences(),
) {
    val session = ShoppingSession(client, notificationPreferences)
    val catalog = CatalogStore(catalog, scope, settings.state.value.locale)
    val assistant = AssistantStore(client, scope)
    init {
        session.onIdentityChange = { assistant.reset(); this.catalog.dismissProduct() }
    }
}
