import RocentoCore
import SwiftUI

private struct AssistantBottomPosition: PreferenceKey {
  static let defaultValue: CGFloat = 0
  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}
@MainActor final class AssistantChatModel: ObservableObject {
  let store: AssistantStore
  var turns: [AssistantTurn] { store.turns }
  var draft: String { get { store.draft } set { store.draft = newValue } }
  var busy: Bool { store.busy }
  var stage: String { store.stage }
  var signInRequired: Bool { store.signInRequired }
  init(store: AssistantStore) { self.store = store; store.onChange = { [weak self] in self?.objectWillChange.send() } }
  func reset() { store.reset() }
  func stop() { store.stop() }
  func send(_ message: String, locale: String, productID: String? = nil, cartContext: Bool = false,
    settled: @escaping @MainActor () async -> Void, checkout: @escaping @MainActor () -> Void) {
    store.send(message, locale: locale, productID: productID, cartContext: cartContext, settled: settled, checkout: checkout)
  }
}
struct AssistantView: View {
  @ObservedObject var chat: AssistantChatModel
  @ObservedObject var shopping: ShoppingModel
  let locale: String
  let close: () -> Void
  let navigate: (String) -> Void
  let openProduct: (String) -> Void
  @FocusState private var composing: Bool
  @State private var followReplies = true
  @State private var nearBottom = true
  @State private var dragging = false
  private func t(_ en: String, _ ar: String) -> String { locale == "ar" ? ar : en }
  private var locked: Bool { chat.busy || shopping.busy || shopping.uncertainCheckout }
  private func send(_ text: String, product: String? = nil, cart: Bool = false) {
    guard !shopping.busy, !shopping.uncertainCheckout else { return }
    composing = false
    followReplies = true
    chat.send(text, locale: locale, productID: product, cartContext: cart,
      settled: { await shopping.refreshAssistantCart() }, checkout: { navigate(shopping.customer == nil ? "account" : "cart") })
  }
  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        GeometryReader { viewport in
        ScrollViewReader { proxy in
          ScrollView {
            LazyVStack(alignment: .leading, spacing: 24) {
              if chat.turns.isEmpty {
                VStack(alignment: .leading, spacing: 14) {
                  Image(systemName: "bubble.left.and.bubble.right").font(.largeTitle).foregroundStyle(.tint)
                  Text(t("Find something you’ll love", "اعثر على ما يناسبك")).font(.title2.bold())
                  Text(t("Ask for recommendations, compare products, or get help with your bag.", "اطلب ترشيحات أو قارن المنتجات أو احصل على مساعدة في سلتك.")).foregroundStyle(.secondary)
                  Button(t("Where is my last order?", "أين طلبي الأخير؟")) { send(t("Where is my last order?", "أين طلبي الأخير؟")) }
                    .buttonStyle(.storefrontSecondary).disabled(locked)
                  Button(t("Recommended today", "ترشيحات اليوم")) { send(t("Recommend a product for today", "رشّح لي منتجاً لليوم")) }
                    .buttonStyle(.storefrontSecondary).disabled(locked)
                  SupportControls(shopping: shopping, locale: locale, label: t("Show my tickets", "اعرض تذاكري"), showTickets: true)
                    .buttonStyle(.storefrontSecondary)
                  Button(t("Find best sellers", "الأكثر مبيعاً")) { send(t("Recommend best-selling products", "رشّح لي المنتجات الأكثر مبيعاً")) }
                    .buttonStyle(.storefrontSecondary).disabled(locked)
                  Button(t("Best discounts today", "أفضل خصومات اليوم")) { send(t("Recommend products with the best discounts today", "رشّح لي المنتجات بأفضل الخصومات اليوم")) }
                    .buttonStyle(.storefrontSecondary).disabled(locked)
                  Button(t("Best value items", "أفضل المنتجات قيمة")) { send(t("Recommend the best value products", "رشّح لي أفضل المنتجات قيمة مقابل السعر")) }
                    .buttonStyle(.storefrontSecondary).disabled(locked)
                }.padding(.vertical, 20)
              }
              AssistantLibraryControls(shopping: shopping, chat: chat, locale: locale)
              ForEach(chat.turns) { turn in
                VStack(alignment: .leading, spacing: 16) {
                  Text(turn.question).padding(14).background(.tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 18))
                    .frame(maxWidth: .infinity, alignment: .trailing).textSelection(.enabled)
                  if !turn.reply.text.isEmpty { Text(turn.reply.text).textSelection(.enabled).accessibilityIdentifier("assistant-reply") }
                  ForEach(Array(turn.reply.blocks.enumerated()), id: \.offset) { _, block in blockView(block) }
                  if let order = turn.reply.order { Button(t("View order", "عرض الطلب") + " #\(order["number"].integer)") { navigate("account") } }
                  if turn.reply.ticket != nil { Text(t("Your support request has been received.", "تم استلام طلب الدعم.")) }
                  if shopping.customer != nil, let id = turn.reply.ticket?["ticket"]["id"].string, UUID(uuidString: id) != nil { SupportControls(shopping: shopping, locale: locale, ticket: id) }
                  if turn.reply.needsLogin { Button(t("Sign in", "تسجيل الدخول")) { navigate("account") } }
                  if turn.reply.needsAddress { Button(t("Choose delivery address", "اختيار عنوان التوصيل")) { navigate("account") } }
                  if turn.id == chat.turns.last?.id, let clarification = turn.reply.clarification {
                    Text(clarification.question).font(.headline)
                    ForEach(clarification.choices ?? [], id: \.self) { choice in
                      Button(choice) { send(choice) }.buttonStyle(.storefrontSecondary).disabled(locked)
                    }
                  }
                  if turn.interrupted {
                    Text(t("Response interrupted. Check your bag before sending again; changes may already have been applied.", "انقطع الرد. تحقق من سلتك قبل الإرسال مجدداً؛ ربما تم تطبيق تغييرات بالفعل.")).font(.callout).foregroundStyle(.secondary).accessibilityIdentifier("assistant-interrupted")
                    Button(t("Check bag", "التحقق من السلة")) { navigate("cart") }
                  }
                }
              }
              if chat.busy { HStack { ProgressView(); Text(progress).font(.callout) }.accessibilityIdentifier("assistant-progress") }
              if chat.signInRequired { Button(t("Sign in to continue", "سجّل الدخول للمتابعة")) { navigate("account") } }
              if let error = shopping.error { Text(error).foregroundStyle(.red) }
              if let notice = shopping.notice { Text(notice).font(.callout).accessibilityIdentifier("assistant-cart-notice") }
              Color.clear.frame(height: 1).id("assistant-bottom")
                .background(GeometryReader { geometry in
                  Color.clear.preference(key: AssistantBottomPosition.self, value: geometry.frame(in: .named("assistant-scroll")).maxY)
                })
            }.padding(20)
          }.scrollDismissesKeyboard(.interactively)
            .coordinateSpace(name: "assistant-scroll")
            .onPreferenceChange(AssistantBottomPosition.self) { bottom in
              nearBottom = bottom >= 0 && bottom <= viewport.size.height + 60
              if nearBottom && !dragging { followReplies = true }
            }
            .simultaneousGesture(DragGesture().onChanged { _ in
              dragging = true; followReplies = false
            }.onEnded { _ in dragging = false; followReplies = nearBottom })
            .onChange(of: chat.turns.last?.reply.text) { _, _ in if followReplies { proxy.scrollTo("assistant-bottom", anchor: .bottom) } }
            .onChange(of: chat.busy) { _, _ in if followReplies { proxy.scrollTo("assistant-bottom", anchor: .bottom) } }
            .overlay(alignment: .bottomTrailing) {
              if !followReplies {
                Button { followReplies = true; proxy.scrollTo("assistant-bottom", anchor: .bottom) } label: {
                  Label(t("Jump to latest", "انتقل إلى آخر رسالة"), systemImage: "arrow.down")
                }.buttonStyle(.borderedProminent).padding().accessibilityIdentifier("assistant-jump-latest")
              }
            }
        }
        }
        Divider()
        VStack(spacing: 8) {
          if shopping.uncertainCheckout { Text(t("Resolve your pending checkout before changing your bag.", "تحقق من نتيجة طلبك المعلق قبل تعديل السلة.")).font(.caption) }
          HStack(alignment: .bottom) {
            TextField(t("Ask your shopping assistant…", "اسأل مساعد التسوق…"), text: $chat.draft, axis: .vertical)
              .lineLimit(1...5).textFieldStyle(.roundedBorder).focused($composing).accessibilityIdentifier("assistant-input")
            if chat.busy {
              Button { chat.stop() } label: { Image(systemName: "stop.fill").padding(10) }
                .accessibilityLabel(t("Stop response", "إيقاف الرد")).accessibilityIdentifier("assistant-stop")
            } else {
              Button { send(chat.draft) } label: { Image(systemName: "arrow.up").padding(10) }
                .buttonStyle(.storefrontPrimary).disabled(locked || chat.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || chat.draft.unicodeScalars.count > 4000)
                .accessibilityLabel(t("Send message", "إرسال الرسالة")).accessibilityIdentifier("assistant-send")
            }
          }
          if chat.draft.unicodeScalars.count > 4000 { Text(t("Use 4,000 characters or fewer.", "استخدم ٤٠٠٠ حرف أو أقل.")).font(.caption).foregroundStyle(.red) }
        }.padding()
      }
      .navigationTitle(t("Shopping assistant", "مساعد التسوق")).navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button(t("Done", "تم"), action: close).accessibilityIdentifier("assistant-close") }
        ToolbarItem(placement: .primaryAction) {
          Menu {
            Button(t("View bag & checkout", "عرض السلة وإتمام الطلب")) { navigate("cart") }
            Button(t("Delivery address", "عنوان التوصيل")) { navigate("account") }
            Button(t("New conversation", "محادثة جديدة")) { chat.reset() }.disabled(chat.busy)
          } label: { Image(systemName: "ellipsis.circle") }.accessibilityLabel(t("Chat options", "خيارات المحادثة"))
        }
      }
    }.environment(\.layoutDirection, locale == "ar" ? .rightToLeft : .leftToRight)
      .task { await shopping.client.setLocale(locale); await shopping.load() }
      .onDisappear { chat.stop() }
  }
  private var progress: String {
    switch chat.stage {
    case "catalog": return t("Checking the catalog…", "جارٍ البحث في المنتجات…")
    case "order": return t("Checking your order…", "جارٍ التحقق من طلبك…")
    case "support": return t("Contacting support…", "جارٍ التواصل مع الدعم…")
    case "responding": return t("Writing a response…", "جارٍ كتابة الرد…")
    default: return t("Understanding your request…", "جارٍ فهم طلبك…")
    }
  }
  @ViewBuilder private func blockView(_ block: AssistantBlock) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      if let title = block.title { Text(title).font(.headline) }
      if let text = block.text { Text(text).textSelection(.enabled) }
      if let products = block.products {
        ForEach(products) { product in
          VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 14) {
              MerchantImage(url: product.image_id.flatMap { shopping.client.imageURL($0) }).frame(width: 88, height: 88).clipShape(RoundedRectangle(cornerRadius: 12)).accessibilityHidden(true)
              VStack(alignment: .leading, spacing: 6) {
                Text(product.name).font(.headline)
                Text("\(product.price) \(product.currency)").font(.subheadline.bold())
                if let original = product.original_price { Text("\(original) \(product.currency)").strikethrough().font(.caption).foregroundStyle(.secondary) }
                if let stock = product.in_stock { Text(stock ? t("Available", "متوفر") : t("Out of stock", "غير متوفر")).font(.caption) }
              }
            }
            ForEach(product.reasons, id: \.self) { Text($0).font(.callout) }
            ForEach(product.unmet, id: \.self) { Text($0).font(.caption).foregroundStyle(.secondary) }
            ForEach(Array(product.attributes.prefix(5).enumerated()), id: \.offset) { _, attribute in Text("\(attribute.name): \(attribute.value)").font(.caption) }
            HStack {
              Button(t("View product", "عرض المنتج")) { openProduct(product.id) }.accessibilityIdentifier("assistant-product-\(product.id)")
              SwiftUI.Spacer()
              Button(t("Add to bag", "إضافة للسلة")) {
                if shopping.customer == nil { navigate("account") }
                else if shopping.selectedLocation.isEmpty { navigate("account") }
                else { Task { await shopping.addAssistantProduct(product.id, locale: locale, openProduct: openProduct) } }
              }.buttonStyle(.storefrontPrimary).disabled(locked || product.in_stock == false).accessibilityIdentifier("assistant-add-\(product.id)")
            }
            Button(t("Ask about this product", "اسأل عن هذا المنتج")) { send(t("Tell me more about this product", "أخبرني المزيد عن هذا المنتج"), product: product.id) }.font(.callout).disabled(locked)
          }.padding(16).background(Color.secondary.opacity(0.07), in: RoundedRectangle(cornerRadius: 18))
        }
        if let rows = block.rows {
          ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
            VStack(alignment: .leading, spacing: 6) {
              Text(row.label).font(.headline)
              ForEach(Array(products.enumerated()), id: \.offset) { index, product in Text("\(product.name): \(row.values[index])").font(.callout) }
            }
          }
        }
      }
      switch block.kind {
      case "cart_summary":
        if let cart = block.cart {
          ForEach(Array(cart["items"].array.enumerated()), id: \.offset) { _, item in Text("\(item["quantity"].integer) × \(item["name"].string ?? "") · \(item["line_total"].string ?? "") \(cart["currency"].string ?? "")") }
          Text(t("Subtotal", "المجموع الفرعي") + ": \(cart["subtotal"].string ?? "") \(cart["currency"].string ?? "")").bold()
        }
        Button(t("View bag & checkout", "عرض السلة وإتمام الطلب")) { navigate("cart") }.accessibilityIdentifier("assistant-checkout")
      case "cart_removal":
        if let item = block.cart_removal { Text("\(item["name"].string ?? "") · " + t("Remaining: ", "المتبقي: ") + "\(item["remaining_quantity"].integer)") }
        Button(t("View bag", "عرض السلة")) { navigate("cart") }
      case "cart_removal_choice":
        ForEach(Array((block.cart_removal_choice?["items"].array ?? []).enumerated()), id: \.offset) { _, item in
          Button(item["name"].string ?? "") {
            let quantity = block.cart_removal_choice?["quantity"].integer ?? 0
            let message = quantity > 0 ? "Remove \(quantity) of this product from my cart" : "Remove this product from my cart"
            send(message, product: item["product_id"].string)
          }.disabled(locked)
        }
      case "saved_addresses": Button(t("Choose delivery address", "اختيار عنوان التوصيل")) { navigate("account") }
      case "wishlist_manage", "wishlist_transfer": Button(t("Open wishlist", "فتح المفضلة")) { navigate("account") }
      case "action": Button(block.action?["label"].string ?? t("Browse products", "تصفح المنتجات")) { navigate("categories") }
      case "product_prompt":
        if let prompt = block.product_prompt { AssistantProductPromptView(prompt: prompt, shopping: shopping, locale: locale, locked: locked, openProduct: openProduct, send: { send($0, product: $1) }) }
      case "basket_proposal":
        if let id = block.proposal_id { AssistantProposalView(id: id, shopping: shopping, locale: locale, locked: locked, navigate: navigate) }
      case "compound_choice": Text(t("Reply with the product and action you want to use.", "أجب بالمنتج والإجراء الذي تريده."))
      default: EmptyView()
      }
    }
  }
}
