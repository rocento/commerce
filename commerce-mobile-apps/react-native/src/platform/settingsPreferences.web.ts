import { memoryNotificationStorage } from '../core/notificationsStore';
// Native account history is unavailable on the public web build. Fixture state stays in memory.
export const settingsPreferences = memoryNotificationStorage();
