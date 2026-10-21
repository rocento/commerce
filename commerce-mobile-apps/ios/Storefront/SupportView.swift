import RocentoCore
import SwiftUI

struct SupportControls: View {
  @ObservedObject var shopping: ShoppingModel
  let locale: String
  var order: String? = nil
  var ticket: String? = nil
  var label: String? = nil
  var showTickets = false
  @State private var presented = false
  @State private var destination: String?
  @State private var authenticate = false
  private func t(_ en: String, _ ar: String) -> String { locale == "ar" ? ar : en }
  var body: some View {
    Button(label ?? (ticket != nil ? t("View support ticket", "عرض تذكرة الدعم") : order == nil ? t("Support center", "مركز الدعم") : t("Get help with this order", "مساعدة بشأن هذا الطلب"))) {
      if showTickets { shopping.session.support.showList() }
      if let order { shopping.session.support.compose(order: order) }
      if let ticket { Task { await shopping.act(kind: .refresh) { try await shopping.session.support.open(ticket) } } }
      presented = true
    }.disabled(shopping.busy || shopping.uncertainCheckout || shopping.assistant.busy)
      .fullScreenCover(isPresented: $presented, onDismiss: {
        if let id = destination { destination = nil; shopping.session.navigation.open("order"); Task { await shopping.track(id) } }
        if authenticate { authenticate = false; shopping.session.navigation.open("auth") }
      }) {
        NavigationStack {
          ScrollView { SupportContent(shopping: shopping, locale: locale, signIn: { authenticate = true; presented = false }, openOrder: { destination = $0; presented = false }).padding(20) }
            .navigationTitle(t("Support center", "مركز الدعم"))
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(t("Done", "تم")) { presented = false } } }
        }.environment(\.layoutDirection, locale == "ar" ? .rightToLeft : .leftToRight)
      }
  }
}
private struct SupportContent: View {
  @ObservedObject var shopping: ShoppingModel
  let locale: String
  let signIn: () -> Void
  let openOrder: (String) -> Void
  private var store: SupportStore { shopping.session.support }
  private var locked: Bool { shopping.busy || store.busy || shopping.uncertainCheckout || shopping.assistant.busy }
  private func t(_ en: String, _ ar: String) -> String { locale == "ar" ? ar : en }
  private func label(_ value: String) -> String { ["order_issue": t("Order issue", "مشكلة في الطلب"), "product_question": t("Product question", "سؤال عن منتج"), "complaint": t("Complaint", "شكوى"), "payment_dispute": t("Payment dispute", "نزاع دفع"), "other": t("Other", "أخرى"), "open": t("Open", "مفتوحة"), "in_progress": t("In progress", "قيد المعالجة"), "resolved": t("Resolved", "تم الحل"), "closed": t("Closed", "مغلقة"), "high": t("High priority", "أولوية عالية"), "normal": t("Normal priority", "أولوية عادية"), "customer": t("Customer", "العميل"), "admin": t("Support team", "فريق الدعم")][value] ?? value }
  private func input(_ path: WritableKeyPath<SupportInput, String>) -> Binding<String> { Binding(get: { store.draft[keyPath: path] }, set: { var draft = store.draft; draft[keyPath: path] = $0; store.edit(draft) }) }
  private func optional(_ path: WritableKeyPath<SupportInput, String?>) -> Binding<String> { Binding(get: { store.draft[keyPath: path] ?? "" }, set: { var draft = store.draft; draft[keyPath: path] = $0; store.edit(draft) }) }
  private func open(_ id: String) { Task { await shopping.act(kind: .refresh) { try await store.open(id) } } }
  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      if store.busy { ProgressView() }
      if let error = shopping.error { Text(error).foregroundStyle(.red) }
      if store.failed { Text(t("The request could not be completed. Your draft is retained.", "تعذر إكمال الطلب. تم الاحتفاظ بالمسودة.")).foregroundStyle(.red) }
      Button(t("Your tickets", "تذاكرك")) { store.showList(); if shopping.customer != nil { Task { await shopping.act(kind: .refresh) { try await store.refresh() } } } }.disabled(locked)
      Button(store.attempt == nil ? t("Open a ticket", "فتح تذكرة") : t("Resume saved submission", "متابعة الإرسال المحفوظ")) { store.compose() }.disabled(locked)
      if let pending = store.replyAttempt, pending.id != store.selected { Button(t("Return to pending reply", "العودة للرد المعلق")) { open(pending.id) }.disabled(locked) }
      if store.composing { form }
      else if let id = store.selected {
        if shopping.customer != nil { Button(t("Refresh ticket", "تحديث التذكرة")) { open(id) }.disabled(locked) }
        if let detail = store.detail { ticket(detail) }
      } else if shopping.customer != nil {
        if store.loaded && store.tickets.isEmpty { Text(t("No support tickets yet", "لا توجد تذاكر دعم بعد")) }
        ForEach(store.tickets) { ticket in
          Button { open(ticket.id) } label: { VStack(alignment: .leading) { Text("#\(ticket.number) · \(ticket.subject)").bold(); Text(label(ticket.status) + " · " + label(ticket.category)); Text(label(ticket.priority)).font(.caption) }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 10) }.disabled(locked)
          Divider()
        }
      } else { Button(t("Sign in to view your tickets", "سجل الدخول لعرض تذاكرك"), action: signIn).disabled(locked) }
    }.task(id: shopping.customer?.id) { if shopping.customer != nil { await shopping.act(kind: .refresh) { try await store.refresh() } } }
  }
  private var form: some View {
    VStack(alignment: .leading, spacing: 14) {
      if let id = store.draft.order_id {
        Button(t("Linked order", "الطلب المرتبط")) { openOrder(id) }.disabled(locked)
        Button(t("Remove linked order", "إزالة الطلب المرتبط")) { var draft = store.draft; draft.order_id = nil; store.edit(draft) }.disabled(locked || store.attempt != nil)
      }
      Group {
        TextField(t("Subject", "الموضوع"), text: input(\.subject)).textFieldStyle(.roundedBorder)
        Picker(t("Category", "الفئة"), selection: input(\.category)) { ForEach(supportCategories, id: \.self) { Text(label($0)).tag($0) } }.pickerStyle(.menu)
        TextField(t("Message", "الرسالة"), text: input(\.body), axis: .vertical).lineLimit(4...10).textFieldStyle(.roundedBorder)
        if shopping.customer == nil {
          TextField(t("Your name", "اسمك"), text: optional(\.contact_name)).textFieldStyle(.roundedBorder)
          TextField(t("Email or mobile number", "البريد الإلكتروني أو رقم الهاتف"), text: optional(\.contact)).textInputAutocapitalization(.never).textFieldStyle(.roundedBorder)
        }
      }.disabled(locked || store.attempt != nil)
      Text(t("Subject: 160 bytes maximum. Message: 2000 bytes maximum.", "الموضوع: ١٦٠ بايت كحد أقصى. الرسالة: ٢٠٠٠ بايت كحد أقصى.")).font(.caption)
      if store.attempt != nil { Text(t("The result is unconfirmed. Retry the same saved submission.", "النتيجة غير مؤكدة. أعد محاولة الإرسال المحفوظ نفسه.")) }
      Button(store.attempt == nil ? t("Submit ticket", "إرسال التذكرة") : t("Retry saved submission", "إعادة محاولة الإرسال المحفوظ")) { Task { await shopping.act { try await store.create(signedIn: shopping.customer != nil) } } }
        .buttonStyle(.storefrontPrimary).disabled(locked || (store.attempt == nil && !store.draft.valid(signedIn: shopping.customer != nil)))
    }
  }
  private func ticket(_ detail: SupportDetail) -> some View {
    VStack(alignment: .leading, spacing: 14) {
      if store.created { Text(t("Support ticket created", "تم إنشاء تذكرة الدعم")) }
      Text("#\(detail.ticket.number) · \(detail.ticket.subject)").font(.title2.bold())
      Text(label(detail.ticket.status) + " · " + label(detail.ticket.priority)); Text(label(detail.ticket.category))
      Text(["resolved", "closed"].contains(detail.ticket.status) ? t("Completed", "مكتملة") : detail.ticket.status == "open" ? t("Awaiting first response", "بانتظار الرد الأول") : t("Team is investigating", "الفريق يبحث المشكلة"))
      if let id = detail.ticket.order_id { Button(t("Linked order", "الطلب المرتبط")) { openOrder(id) }.disabled(locked) }
      ForEach(detail.messages) { message in
        Text(label(message.sender)).bold(); Text(CommercePresentation.dateTime(message.created_at, locale: locale)).font(.caption); Text(message.body); Divider()
      }
      if shopping.customer != nil {
        if store.replied { Text(t("Reply sent", "تم إرسال الرد")) }
        TextField(t("Reply", "الرد"), text: Binding(get: { store.reply }, set: { store.editReply($0) }), axis: .vertical).lineLimit(4...10).textFieldStyle(.roundedBorder).disabled(locked || store.replyAttempt != nil)
        if store.replyAttempt != nil { Text(t("Reply outcome is unconfirmed. Retry the same saved reply.", "نتيجة الرد غير مؤكدة. أعد محاولة الرد المحفوظ نفسه.")) }
        if detail.messages.count >= 100 && store.replyAttempt == nil { Text(t("This ticket has reached its message limit. Open a new ticket.", "بلغت التذكرة حد الرسائل. افتح تذكرة جديدة.")) }
        Button(store.replyAttempt == nil ? t("Send reply", "إرسال الرد") : t("Retry saved reply", "إعادة محاولة الرد المحفوظ")) { Task { await shopping.act { try await store.sendReply() } } }.buttonStyle(.storefrontPrimary)
          .disabled(locked || (store.replyAttempt != nil ? store.replyAttempt?.id != store.selected : !supportTextValid(store.reply, max: 2000) || detail.messages.count >= 100))
      } else { Text(t("Keep your ticket number. Our team will use the contact details you provided.", "احتفظ برقم التذكرة. سيتواصل الفريق باستخدام بيانات الاتصال التي قدمتها.")) }
    }
  }
}
