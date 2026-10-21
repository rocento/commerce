import RocentoCore
import SwiftUI

struct ReviewsView: View {
  @ObservedObject var shopping: ShoppingModel
  let product: String
  let locale: String
  let signIn: () -> Void
  private var store: ReviewsStore { shopping.session.reviews }
  private var locked: Bool { shopping.busy || shopping.uncertainCheckout || store.busy }
  private func t(_ en: String, _ ar: String) -> String { locale == "ar" ? ar : en }
  private func input<Value>(_ path: WritableKeyPath<ReviewInput, Value>) -> Binding<Value> { Binding(get: { store.draft[keyPath: path] }, set: { value in var draft = store.draft; draft[keyPath: path] = value; store.edit(draft) }) }
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(t("Customer reviews", "تقييمات العملاء")).font(.title2.bold()).accessibilityAddTraits(.isHeader)
      if store.product == product {
        if let error = shopping.error { Text(error).foregroundStyle(.red) }
        if store.busy { ProgressView() }
        if store.failed { Text(t("Unable to refresh reviews", "تعذر تحديث التقييمات")).foregroundStyle(.red) }
        if store.loaded && store.reviews.isEmpty { Text(t("No reviews yet", "لا توجد تقييمات بعد")) }
        ForEach(store.reviews) { review in
          VStack(alignment: .leading, spacing: 6) {
            Text(review.display_name + " · \(review.rating)/5"); Text(review.title).bold(); Text(review.body); Divider()
          }
        }
        HStack {
          Button(t("Previous reviews", "التقييمات السابقة")) { refresh(max(0, store.offset - 50)) }.disabled(locked || store.offset == 0)
          Button(t("Next reviews", "التقييمات التالية")) { refresh(store.offset + 50) }.disabled(locked || store.reviews.count < 50)
        }
        Button(t("Refresh reviews", "تحديث التقييمات")) { refresh(store.offset) }.disabled(locked)
        if store.submitted { Text(t("Review submitted for moderation", "تم إرسال التقييم للمراجعة")) }
        if store.uncertain { Text(t("The submission result is uncertain. Refresh reviews before retrying.", "نتيجة الإرسال غير مؤكدة. حدّث التقييمات قبل إعادة المحاولة.")) }
        if shopping.customer?.verified == true {
          Text(store.own == nil ? t("Write a review", "اكتب تقييماً") : t("Edit your review", "تعديل تقييمك")).font(.headline)
          if let own = store.own { Text(status(own.status ?? "pending")); if let reason = own.moderation_reason { Text(reason) } }
          Text(t("Editing an approved review sends it back for approval.", "تعديل التقييم المعتمد يعيده للمراجعة.")).font(.caption)
          Group {
            TextField(t("Public display name", "الاسم المعروض"), text: input(\.display_name)).textFieldStyle(.roundedBorder)
            Picker(t("Rating", "التقييم"), selection: input(\.rating)) { ForEach(1...5, id: \.self) { Text("\($0)/5").tag($0) } }.pickerStyle(.segmented)
            TextField(t("Review title", "عنوان التقييم"), text: input(\.title)).textFieldStyle(.roundedBorder)
            TextField(t("Your review", "تقييمك"), text: input(\.body), axis: .vertical).lineLimit(4...10).textFieldStyle(.roundedBorder)
          }.disabled(locked || store.uncertain)
          if store.dirty && !store.draft.valid { Text(t("Complete all fields within the limits: name 80 bytes, title 200, review 4000.", "أكمل الحقول ضمن الحدود: الاسم ٨٠ بايت، العنوان ٢٠٠، والتقييم ٤٠٠٠.")).font(.caption) }
          Button(t("Submit for moderation", "إرسال للمراجعة")) { Task { await shopping.act { try await store.submit(verified: shopping.customer?.verified == true) } } }
            .buttonStyle(.storefrontPrimary).disabled(locked || !store.ownLoaded || store.uncertain || !store.draft.valid)
        } else { Button(shopping.customer == nil ? t("Sign in to write a review", "سجل الدخول لكتابة تقييم") : t("Verify your account to write a review", "أكد حسابك لكتابة تقييم"), action: signIn) }
      }
    }.task(id: product + (shopping.customer?.id ?? "guest")) { await shopping.act(kind: .refresh) { try await store.open(product, signedIn: shopping.customer != nil) } }
  }
  private func refresh(_ offset: Int) { Task { await shopping.act(kind: .refresh) { try await store.load(signedIn: shopping.customer != nil, offset: offset) } } }
  private func status(_ value: String) -> String { ["pending": t("Pending approval", "بانتظار الموافقة"), "approved": t("Approved", "تمت الموافقة"), "rejected": t("Rejected", "مرفوض")][value] ?? value }
}
