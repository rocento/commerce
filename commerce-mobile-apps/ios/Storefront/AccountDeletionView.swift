import RocentoCore
import SwiftUI

struct AccountDeletionView: View {
  @ObservedObject var shopping: ShoppingModel
  let locale: String
  @State private var policy: AccountRetentionPolicy?
  @State private var status: AccountDeletionStatus?
  @State private var password = ""
  @State private var confirmed = false
  @State private var busy = false
  @State private var message: String?
  private func t(_ en: String, _ ar: String) -> String { locale == "ar" ? ar : en }
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text(t("Delete account", "حذف الحساب")).font(.title.bold())
      if let status {
        Text(status.state == "complete" ? t("Account deleted", "تم حذف الحساب") : t("Deletion in progress", "جارٍ حذف الحساب")).font(.headline)
        Text(t("Your access has been revoked. Deletion retries automatically if a service is unavailable.", "تم إلغاء الوصول إلى حسابك. تُعاد محاولة الحذف تلقائياً إذا كانت إحدى الخدمات غير متاحة."))
        if status.waiting_reason != nil {
          Text(t("Deletion is waiting for outstanding orders, disputes, or a legal hold to be resolved.", "ينتظر الحذف تسوية الطلبات أو النزاعات القائمة أو انتهاء الحجز القانوني."))
        }
        if let until = status.retained_until { Text(t("Required transaction records retained until: ", "تُحفظ سجلات المعاملات المطلوبة حتى: ") + until) }
        Button(t("Refresh deletion status", "تحديث حالة الحذف")) { Task { await load() } }
      } else if let policy, shopping.customer != nil {
        Text(t("This permanently deletes your profile, saved addresses, wishlist and assistant history. You will be signed out immediately. Outstanding orders and disputes must be resolved before erasure completes.", "سيُحذف ملفك الشخصي وعناوينك ومفضلتك وسجل المساعد نهائياً. سيُسجَّل خروجك فوراً. يجب تسوية الطلبات والنزاعات القائمة قبل اكتمال الحذف."))
        Text(policy.legal_entity).font(.headline)
        Text(policy.jurisdictions.joined(separator: ", "))
        Text(t("Identifiable financial records: ", "السجلات المالية المرتبطة بك: ") + String(policy.financial_days) + t(" days from the order’s last update.", " يوماً من آخر تحديث للطلب."))
        Text(policy.retain_contact ? t("Invoice contact details are retained.", "تُحفظ بيانات الاتصال الخاصة بالفاتورة.") : t("Invoice contact details are removed.", "تُحذف بيانات الاتصال الخاصة بالفاتورة."))
        Text(policy.retain_address ? t("Invoice address is retained.", "يُحفظ عنوان الفاتورة.") : t("Invoice address is removed.", "يُحذف عنوان الفاتورة."))
        SecureField(t("Current password", "كلمة المرور الحالية"), text: $password).textContentType(.password).textFieldStyle(.roundedBorder)
        Toggle(t("I understand this cannot be undone", "أفهم أنه لا يمكن التراجع عن هذا الإجراء"), isOn: $confirmed)
        Button(t("Permanently delete account", "حذف الحساب نهائياً"), role: .destructive) {
          Task {
            busy = true; message = nil
            do {
              status = try await shopping.client.deleteAccount(policy: policy, password: password)
              password = ""; shopping.session.account.reset()
            } catch let error as AccountDeletionCleanupFailure {
              status = error.status; password = ""; shopping.session.account.reset()
              message = t("Deletion was accepted. Refresh to retry clearing saved credentials on this device.", "تم قبول الحذف. حدّث لإعادة محاولة مسح بيانات الدخول المحفوظة على هذا الجهاز.")
            } catch { message = t("Deletion could not be confirmed. Refresh the status before retrying.", "تعذر تأكيد الحذف. حدّث الحالة قبل إعادة المحاولة.") }
            busy = false
          }
        }.disabled(!confirmed || password.isEmpty || busy).accessibilityIdentifier("confirm-account-deletion")
        Button(t("Check request status", "التحقق من حالة الطلب")) { Task { await load() } }
      } else {
        Text(shopping.customer == nil ? t("Sign in to request deletion, or check a previously submitted request.", "سجّل الدخول لطلب الحذف أو تحقق من طلب سابق.") : t("The merchant must configure its retention policy before deletion is available.", "يجب على التاجر إعداد سياسة الاحتفاظ قبل إتاحة الحذف."))
        Button(t("Refresh", "تحديث")) { Task { await load() } }
      }
      if busy { ProgressView() }
      if let message { Text(message).foregroundStyle(.red) }
    }.disabled(busy).task { await load() }.onDisappear { password = "" }
  }
  private func load() async {
    busy = true; message = nil
    defer { busy = false }
    do {
      let receipt = try await shopping.client.accountDeletionReceipt()
      let ownsReceipt = shopping.customer == nil || shopping.customer?.id == receipt?.customer_id
      do {
        if ownsReceipt, let saved = try await shopping.client.accountDeletionStatus() {
          status = saved; shopping.session.account.reset(); return
        }
      } catch let error as CommerceFailure where error.status == 404 { /* Not admitted yet; allow retry. */ }
      if shopping.customer != nil { policy = try await shopping.client.accountRetentionPolicy() }
    } catch let error as AccountDeletionCleanupFailure {
      status = error.status; shopping.session.account.reset()
      message = t("Deletion was accepted. Refresh to retry clearing saved credentials on this device.", "تم قبول الحذف. حدّث لإعادة محاولة مسح بيانات الدخول المحفوظة على هذا الجهاز.")
    } catch { message = t("Unable to check deletion. Please try again.", "تعذر التحقق من الحذف. حاول مجدداً.") }
  }
}
