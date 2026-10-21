import RocentoCore
import SwiftUI

@MainActor private final class ProposalObserver: ObservableObject {
  let store: AssistantProposalStore
  init(id: String, client: CommerceClient) {
    store = AssistantProposalStore { try await client.assistantProposal(id) }
    store.onChange = { [weak self] in self?.objectWillChange.send() }
  }
}

/// Proposals are reviewed separately from orders. Repeated approval uses the proposal's stable key.
struct AssistantProposalView: View {
  let id: String
  @ObservedObject var shopping: ShoppingModel
  let locale: String
  let locked: Bool
  let navigate: (String) -> Void
  @StateObject private var model: ProposalObserver
  init(id: String, shopping: ShoppingModel, locale: String, locked: Bool, navigate: @escaping (String) -> Void) {
    self.id = id; self.shopping = shopping; self.locale = locale; self.locked = locked; self.navigate = navigate
    _model = StateObject(wrappedValue: ProposalObserver(id: id, client: shopping.client))
  }
  private var proposal: AssistantJSON? { model.store.proposal }
  private var working: Bool { model.store.busy }
  private var pending: Bool { model.store.pending }
  private var problem: String? {
    switch model.store.issue {
    case .load: return t("Unable to load this proposal. Sign in and try again.", "تعذر تحميل المقترح. سجّل الدخول وحاول مجدداً.")
    case .unconfirmed: return t("The outcome is not confirmed. Check again before making more changes.", "لم يتم تأكيد النتيجة. تحقق مجدداً قبل إجراء تغييرات أخرى.")
    case .apply: return t("Unable to confirm the update. Check its status before approving again.", "تعذر تأكيد التحديث. تحقق من حالته قبل الموافقة مجدداً.")
    case nil: return nil
    }
  }
  private func t(_ en: String, _ ar: String) -> String { locale == "ar" ? ar : en }
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(t("Review proposed basket", "مراجعة السلة المقترحة")).font(.headline)
      if let p = proposal { proposalContent(p) }
      if working { ProgressView() }
      if let problem { Text(problem).font(.callout).foregroundStyle(.red) }
      Button(t("Refresh proposal", "تحديث المقترح")) { Task { await reload() } }.disabled(working || locked)
    }.padding(16).background(.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))
      .task(id: id) { await reload() }
      .onChange(of: shopping.customer?.id) { _, _ in model.store.reset() }
      .onDisappear { model.store.reset() }
  }
  private func proposalContent(_ p: AssistantJSON) -> some View {
    VStack(alignment: .leading, spacing: 12) {
        Text(p["draft"]["goal"]["purpose"].string ?? "")
        Text(t("Current basket", "السلة الحالية")).font(.subheadline.bold())
        items(p["current_items"].array)
        Text(t("Basket after approval", "السلة بعد الموافقة")).font(.subheadline.bold())
        items(p["resulting_items"].array)
        totals(p["after"])
        ForEach(Array((p["issues"].array + p["notes"].array).enumerated()), id: \.offset) { _, note in Text(note.string ?? "").font(.caption) }
        if let expiry = p["expires_at"].string { Text(t("Valid until: ", "صالح حتى: ") + CommercePresentation.dateTime(expiry, locale: locale)).font(.caption) }
        if p["applied"].bool {
          Text(t("Applied to your bag. Review checkout separately to place your order.", "تم التطبيق على سلتك. راجع إتمام الطلب بشكل منفصل لتأكيده."))
          Button(t("View bag & checkout", "عرض السلة وإتمام الطلب")) { navigate("cart") }
        } else {
          Text(t("Approval changes your bag; it does not place an order.", "الموافقة تعدّل السلة ولا تؤكد الطلب.")).font(.caption)
          Button(pending ? t("Check update status", "تحقق من حالة التحديث") : t("Approve & apply to bag", "الموافقة والتطبيق على السلة")) {
            if shopping.customer == nil { navigate("account") }
            else if pending { Task { await reload() } }
            else { Task { await apply() } }
          }.buttonStyle(.storefrontPrimary).disabled(working || locked || (!pending && !model.store.canApply))
        }
    }
  }
  private func totals(_ value: AssistantJSON) -> some View {
    let labels = ["subtotal": t("Subtotal", "المجموع الفرعي"), "discount": t("Discount", "الخصم"), "tax": t("Tax", "الضريبة"), "delivery": t("Delivery", "التوصيل"), "payable": t("Total", "الإجمالي")]
    return VStack(alignment: .leading, spacing: 4) {
      ForEach(["subtotal", "discount", "tax", "delivery", "payable"], id: \.self) { key in
        let label = labels[key] ?? key
        let amount = value[key].string ?? t("Not yet verified", "لم يتم التحقق بعد")
        let currency = value["currency"].string ?? ""
        Text("\(label): \(amount) \(currency)")
      }
    }
  }
  private func items(_ values: [AssistantJSON]) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      ForEach(Array(values.enumerated()), id: \.offset) { _, item in
        Text("\(item["quantity"].integer) × \(item["name"].string ?? "") · \(item["line_total"].string ?? "") \(item["currency"].string ?? "")").font(.callout)
      }
    }
  }
  private func reload() async { await model.store.reload { await shopping.refreshAssistantCart() } }
  private func apply() async {
    await model.store.apply(locked: locked, operation: { location in try await shopping.applyProposal(id, location: location) }, settled: { await shopping.refreshAssistantCart() })
  }
}
