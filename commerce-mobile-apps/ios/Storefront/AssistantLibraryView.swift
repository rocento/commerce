import RocentoCore
import SwiftUI

struct AssistantLibraryControls: View {
  @ObservedObject var shopping: ShoppingModel
  @ObservedObject var chat: AssistantChatModel
  let locale: String
  @State private var presented = false
  var body: some View {
    Button(locale == "ar" ? "المحادثات والذاكرة" : "Conversations & memory") { presented = true }
      .disabled(shopping.busy || chat.busy || shopping.uncertainCheckout)
      .fullScreenCover(isPresented: $presented) {
        NavigationStack {
          ScrollView { AssistantLibraryContent(shopping: shopping, chat: chat, locale: locale, close: { presented = false }).id(shopping.customer?.id ?? "guest").padding(20) }
            .navigationTitle(locale == "ar" ? "المحادثات والذاكرة" : "Conversations & memory")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(locale == "ar" ? "العودة للمحادثة" : "Back to chat") { presented = false } } }
        }.environment(\.layoutDirection, locale == "ar" ? .rightToLeft : .leftToRight)
      }
  }
}
private struct AssistantLibraryContent: View {
  @ObservedObject var shopping: ShoppingModel
  @ObservedObject var chat: AssistantChatModel
  let locale: String
  let close: () -> Void
  @State private var search = ""
  @State private var confirmation: MemoryAction?
  @State private var names: [String: String] = [:]
  private var library: AssistantLibrary { shopping.session.library }
  private var busy: Bool { shopping.busy || chat.busy || library.busy || shopping.uncertainCheckout }
  private var writeLocked: Bool { busy || library.needsRefresh }
  private func t(_ en: String, _ ar: String) -> String { locale == "ar" ? ar : en }
  private func label(_ value: String) -> String { ["product": t("Product", "منتج"), "brand": t("Brand", "علامة تجارية"), "color": t("Color", "لون"), "style": t("Style", "نمط"), "metal": t("Metal", "معدن"), "material": t("Material", "خامة"), "any": t("Any occasion", "أي مناسبة"), "everyday": t("Everyday", "يومي"), "gift": t("Gift", "هدية"), "work": t("Work", "عمل"), "travel": t("Travel", "سفر"), "self": t("Me", "أنا"), "other": t("Someone else", "شخص آخر"), "view": t("Viewed", "تمت مشاهدته"), "purchase": t("Purchased", "تم شراؤه"), "return": t("Returned", "تم إرجاعه")][value] ?? value }
  private func input<Value>(_ path: WritableKeyPath<MemoryPreferenceInput, Value>) -> Binding<Value> { Binding(get: { library.draft[keyPath: path] }, set: { var draft = library.draft; draft[keyPath: path] = $0; library.edit(draft) }) }
  private func mutate(_ action: MemoryAction) { Task { await shopping.act { try await library.mutate(action, conversation: chat.store.conversationID, signedIn: shopping.customer != nil) } } }
  private func open(_ id: String) { Task { await shopping.act(kind: .refresh) { try await library.open(id) { try chat.store.restoreConversation(id, history: $0); close() } } } }
  private func refresh() async { await shopping.act(kind: .refresh) { try await library.refresh(conversation: chat.store.conversationID, signedIn: shopping.customer != nil) } }
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      if library.busy { ProgressView() }
      if let error = shopping.error { Text(error).foregroundStyle(.red) }
      if library.failed { Text(t("Unable to complete the request. Refresh to check the current state.", "تعذر إكمال الطلب. حدّث للتحقق من الحالة الحالية.")).foregroundStyle(.red) }
      if library.changed { Text(t("Memory change saved", "تم حفظ تغيير الذاكرة")) }
      if library.needsRefresh { Text(t("Refresh before making another change. The previous change may already be saved.", "حدّث قبل إجراء تغيير آخر. ربما تم حفظ التغيير السابق.")) }
      Button(t("Refresh conversations & memory", "تحديث المحادثات والذاكرة")) { Task { await refresh() } }.disabled(busy)
      Button(t("New conversation", "محادثة جديدة")) { chat.reset(); close() }.disabled(busy)
      Toggle(t("Do not personalize this request", "عدم تخصيص هذا الطلب"), isOn: Binding(get: { !chat.store.personalize }, set: { chat.store.personalize = !$0 })).disabled(busy)
      if shopping.customer != nil {
        TextField(t("Search conversations", "البحث في المحادثات"), text: $search).textFieldStyle(.roundedBorder)
        if library.loaded && library.conversations(search).isEmpty { Text(t("No matching conversations", "لا توجد محادثات مطابقة")) }
        ForEach(library.conversations(search)) { conversation in
          Button { open(conversation.id) } label: { VStack(alignment: .leading, spacing: 6) { Text(conversation.title).bold(); Text(CommercePresentation.dateTime(conversation.updated, locale: locale)).font(.caption) }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 8) }.disabled(busy)
          Divider()
        }
      } else { Text(t("Sign in to view conversations", "سجل الدخول لعرض المحادثات")) }
      if let memory = library.memory {
        if memory.enabled { memoryControls(memory) }
        else { Text(t("Memory is unavailable for this store", "الذاكرة غير متاحة لهذا المتجر")) }
      }
    }.task(id: (shopping.customer?.id ?? "guest") + chat.store.conversationID) { await refresh() }
      .onDisappear { library.clearExport() }
      .confirmationDialog(t("Confirm removal? Completed orders will not be deleted.", "تأكيد الإزالة؟ لن تُحذف الطلبات المكتملة."), isPresented: Binding(get: { confirmation != nil }, set: { if !$0 { confirmation = nil } }), titleVisibility: .visible) {
        Button(t("Confirm removal", "تأكيد الإزالة"), role: .destructive) { if let action = confirmation { confirmation = nil; mutate(action) } }.disabled(writeLocked)
        Button(t("Cancel", "إلغاء"), role: .cancel) { confirmation = nil }
      }
  }
  @ViewBuilder private func memoryControls(_ memory: MemoryView) -> some View {
    Text(t("Memory & personalization", "الذاكرة والتخصيص")).font(.title2.bold())
    Text(memory.guest ? t("Guest catalog context expires within one hour and is not merged into an account.", "تنتهي صلاحية سياق الضيف خلال ساعة ولا يُدمج في الحساب.") : t("Catalog context expires within one day. Saved goals are managed separately.", "تنتهي صلاحية سياق المنتجات خلال يوم. تُدار الأهداف المحفوظة بشكل منفصل.")).font(.caption)
    Toggle(t("Use my saved preferences", "استخدام تفضيلاتي المحفوظة"), isOn: Binding(get: { memory.personalized }, set: { mutate(.consent(personalized: $0, journey: $0 && memory.journey_consent, version: memory.consent_version)) })).disabled(writeLocked)
    Toggle(t("Use recent product views and purchases", "استخدام المشاهدات والمشتريات الأخيرة"), isOn: Binding(get: { memory.journey_consent }, set: { mutate(.consent(personalized: memory.personalized, journey: $0, version: memory.consent_version)) })).disabled(writeLocked || memory.guest || !memory.personalized)
    if memory.personalized { preferenceForm(memory) }
    preferenceList(memory)
    memoryActions(memory)
    Text(t("Saved goals", "الأهداف المحفوظة")).font(.title2.bold())
    if shopping.customer == nil { Text(t("Sign in to manage saved goals", "سجل الدخول لإدارة الأهداف المحفوظة")) }
    else if library.goals.isEmpty { Text(t("No saved goals", "لا توجد أهداف محفوظة")) }
    ForEach(library.goals) { goal in goalControls(goal) }
  }
  private func preferenceTitle(_ preference: MemoryPreference, _ memory: MemoryView) -> String {
    let prefix = preference.signal == "explicit_dislike" ? t("Dislike", "لا أفضل") : t("Prefer", "أفضل")
    let value = preference.attribute == "product" ? (memory.products.first { $0.id == preference.value }?.name ?? t("Saved product", "منتج محفوظ")) : preference.value
    return prefix + " " + label(preference.attribute) + ": " + value
  }
  @ViewBuilder private func preferenceList(_ memory: MemoryView) -> some View {
    Text(t("Saved preferences", "التفضيلات المحفوظة")).font(.headline)
    if memory.preferences.isEmpty { Text(t("No saved preferences", "لا توجد تفضيلات محفوظة")) }
    ForEach(memory.preferences) { preference in
      Text(preferenceTitle(preference, memory))
      Text(label(preference.recipient) + " · " + label(preference.occasion)).font(.caption)
      Button(t("Edit preference", "تعديل التفضيل")) { library.edit(preference.input) }.disabled(writeLocked || !memory.personalized)
      Button(t("Remove preference", "إزالة التفضيل")) { confirmation = .removePreference(preference.id) }.disabled(writeLocked)
      Divider()
    }
  }
  @ViewBuilder private func memoryActions(_ memory: MemoryView) -> some View {
    Text(t("Recent signals used", "الإشارات الأخيرة المستخدمة")).font(.headline)
    if memory.signals.isEmpty { Text(t("No eligible recent signals", "لا توجد إشارات حديثة مؤهلة")) }
    ForEach(Array(memory.signals.enumerated()), id: \.offset) { _, signal in Text(label(signal.kind) + " " + signal.name) }
    Button(t("Forget this context", "نسيان هذا السياق")) { confirmation = .clearContext(chat.store.conversationID) }.disabled(writeLocked)
    Button(t("Export memory", "تصدير الذاكرة")) { Task { await shopping.act(kind: .refresh) { try await library.export() } } }.disabled(busy)
    if let value = library.exported { ShareLink(item: value) { Label(t("Share JSON", "مشاركة JSON"), systemImage: "square.and.arrow.up") }.disabled(busy) }
    Button(t("Delete personal memory", "حذف الذاكرة الشخصية"), role: .destructive) { confirmation = .delete }.disabled(writeLocked)
    Text(t("Deleting memory turns personalization off. Saved goals and orders are separate.", "حذف الذاكرة يوقف التخصيص. الأهداف والطلبات منفصلة.")).font(.caption)
  }
  private func preferenceForm(_ memory: MemoryView) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Picker(t("Category", "الفئة"), selection: input(\.category_id)) { Text(t("Choose category", "اختر الفئة")).tag(""); ForEach(memory.categories) { Text($0.name).tag($0.id) } }.pickerStyle(.menu)
      Picker(t("Preference", "التفضيل"), selection: Binding(get: { library.draft.attribute }, set: { var draft = library.draft; draft.attribute = $0; draft.value = ""; library.edit(draft) })) { ForEach(preferenceAttributes, id: \.self) { Text(label($0)).tag($0) } }.pickerStyle(.menu)
      if library.draft.attribute == "product" {
        Picker(t("Recently suggested product", "منتج مقترح مؤخراً"), selection: Binding(get: { library.draft.value }, set: { var draft = library.draft; draft.value = $0; draft.category_id = memory.products.first { $0.id == draft.value }?.category_id ?? draft.category_id; library.edit(draft) })) { Text(t("Choose product", "اختر المنتج")).tag(""); ForEach(memory.products) { Text($0.name).tag($0.id) } }.pickerStyle(.menu)
      } else { TextField(t("Preference value", "قيمة التفضيل"), text: input(\.value)).textFieldStyle(.roundedBorder) }
      Picker(t("For", "لمن"), selection: input(\.recipient)) { Text(label("self")).tag("self"); Text(label("other")).tag("other") }.pickerStyle(.segmented)
      Picker(t("Occasion", "المناسبة"), selection: input(\.occasion)) { ForEach(memoryOccasions, id: \.self) { Text(label($0)).tag($0) } }.pickerStyle(.menu)
      Toggle(t("I dislike this option", "لا أفضل هذا الخيار"), isOn: input(\.dislike))
      Button(library.draft.replaces == nil ? t("Save preference", "حفظ التفضيل") : t("Update preference", "تحديث التفضيل")) { mutate(.preference(library.draft)) }.disabled(!library.draft.valid(memory))
      if library.draft.replaces != nil { Button(t("Cancel edit", "إلغاء التعديل")) { library.edit(MemoryPreferenceInput()) } }
    }.disabled(writeLocked)
  }
  private func goalControls(_ goal: SavedGoal) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      TextField(t("Goal name", "اسم الهدف"), text: Binding(get: { names[goal.id] ?? goal.name }, set: { names[goal.id] = $0 })).textFieldStyle(.roundedBorder).disabled(writeLocked)
      Text((goal.archived ? t("Archived", "مؤرشف") : goal.state ?? "") + " · " + CommercePresentation.dateTime(goal.expires_at, locale: locale)).font(.caption)
      Button(t("Continue goal", "متابعة الهدف")) { Task { await shopping.act(kind: .refresh) { try await library.resumeGoal(goal.id) { try chat.store.restoreConversation(goal.id, history: $0); close() } } } }.disabled(busy || !memoryGoalActive(goal))
      Button(t("Rename goal", "إعادة تسمية الهدف")) { mutate(.goal(goal, name: names[goal.id] ?? goal.name, archived: goal.archived)) }.disabled(writeLocked || (names[goal.id] ?? goal.name).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      Button(goal.archived ? t("Unarchive goal", "إلغاء أرشفة الهدف") : t("Archive goal", "أرشفة الهدف")) { mutate(.goal(goal, name: goal.name, archived: !goal.archived)) }.disabled(writeLocked)
      Button(t("Delete goal", "حذف الهدف"), role: .destructive) { confirmation = .deleteGoal(goal) }.disabled(writeLocked)
      Divider()
    }
  }
}
