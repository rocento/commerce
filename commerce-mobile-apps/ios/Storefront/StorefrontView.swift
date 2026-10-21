import ImageIO
import RocentoCore
import SwiftUI

extension Color {
  init(hex: String) {
    let v = UInt32(hex.dropFirst(), radix: 16) ?? 0
    self.init(
      red: Double((v >> 16) & 255) / 255, green: Double((v >> 8) & 255) / 255,
      blue: Double(v & 255) / 255)
  }
}
// Use the same circular corner geometry as Compose and the Studio preview.
// SwiftUI's built-in bordered buttons use a continuous curve even with an explicit radius.
struct StorefrontButtonTheme {
  var radius: CGFloat = 18
  var primary: Color = .accentColor
  var onPrimary: Color = .white
  var background: Color = .white
  var surface: Color = .white
  var text: Color = .primary
}
private struct StorefrontButtonThemeKey: EnvironmentKey {
  static let defaultValue = StorefrontButtonTheme()
}
extension EnvironmentValues {
  var storefrontButtonTheme: StorefrontButtonTheme {
    get { self[StorefrontButtonThemeKey.self] }
    set { self[StorefrontButtonThemeKey.self] = newValue }
  }
}
struct StorefrontActionButtonStyle: ButtonStyle {
  let prominent: Bool
  @Environment(\.storefrontButtonTheme) private var theme
  @Environment(\.isEnabled) private var enabled
  func makeBody(configuration: Configuration) -> some View {
    let shape = RoundedRectangle(cornerRadius: theme.radius, style: .circular)
    return configuration.label
      .padding(.horizontal, 16).padding(.vertical, 12)
      .frame(minHeight: 52)
      .foregroundStyle(prominent ? theme.onPrimary : theme.primary)
      .background(prominent ? theme.primary : theme.primary.opacity(0.08), in: shape)
      .overlay(shape.strokeBorder(prominent ? Color.clear : theme.primary, lineWidth: 1))
      .contentShape(shape)
      .opacity(enabled ? (configuration.isPressed ? 0.8 : 1) : 0.45)
  }
}
extension ButtonStyle where Self == StorefrontActionButtonStyle {
  static var storefrontPrimary: Self { Self(prominent: true) }
  static var storefrontSecondary: Self { Self(prominent: false) }
}

struct StorefrontView: View {
  @ObservedObject private var orderPush = OrderPush.shared
  @State private var searchQuery = ""
  @State private var deliveryLocationPresented = false
  @State private var categoryFiltersPresented = false
  @State private var quickPurchase = false
  @State private var filterDraft = CatalogFilters()
  @State private var assistantProductToOpen: String?
  @State private var dealProducts: [Product] = []
  @State private var dealOffset = 0
  @State private var dealsHaveMore = true
  @State private var dealsLoading = false
  @State private var dealsFailed = false
  @ObservedObject private var headerShopping: ShoppingModel
  @ObservedObject var model: StorefrontModel
  init(model: StorefrontModel) {
    self.model = model
    self.headerShopping = model.shopping
  }
  @Environment(\.openURL) private var openURL
  private var storefront: Bool { model.config?.screens.home.layout?.rawValue == "storefront" }
  @Environment(\.dynamicTypeSize) var textSize
  private var palette: Palette? {
    model.config?.brand.light
  }
  private var radius: CGFloat {
    switch model.config?.brand.radiusToken.rawValue {
    case "none": return 0
    case "small": return 8
    case "large": return 28
    default: return 18
    }
  }
  private var gap: CGFloat { model.config?.brand.density.rawValue == "compact" ? 12 : 20 }
  var body: some View {
    Group {
      if let config = model.config, let palette {
        NavigationStack {
        TabView(selection: $model.selectedTab) {
          ForEach(config.navigation.tabs.map(\.rawValue), id: \.self) { tab in
            NavigationStack {
              Group {
              if tab == "cart" && model.production {
                CommerceView(shopping: model.shopping, locale: model.locale, tab: tab, toggleLanguage: { Task { await model.toggleLanguage() } }, wishlistEnabled: config.features.wishlist, openHelp: { model.assistantPresented = true }, openProduct: { id in Task { await model.product(id) } }, shop: { model.selectedTab = "categories" })
              } else {
              ScrollViewReader { accountScroll in
              ScrollView {
                VStack(alignment: .leading, spacing: gap) {
                  if let problem = model.problem {
                    Text(problem).font(.callout).accessibilityIdentifier("load-error")
                  }
                  if tab == "home" {
                    if !storefront { Text(model.copy("YOUR EVERYDAY, BEAUTIFULLY CHOSEN", "اختيارات مميزة لكل يوم"))
                      .font(.caption).tracking(model.locale == "ar" ? 0 : 1.8).padding(.top, 8) }
                    ForEach(config.screens.home.sections, id: \.id) { section in
                      render(section, config: config, palette: palette)
                    }
                  } else if tab == "deals" {
                    dealsContent(palette: palette)
                  } else if tab == "categories" {
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: textSize.isAccessibilitySize ? 1 : 3), alignment: .leading, spacing: 20) {
                      ForEach(model.categories) { category in
                        Button { Task { await model.category(category.id) } } label: {
                          VStack(spacing: 8) {
                            MerchantImage(url: category.thumbnail.flatMap { model.shopping.client.imageURL($0) })
                              .aspectRatio(1, contentMode: .fit)
                              .background(Color(hex: palette.primary).opacity(0.07))
                              .clipShape(RoundedRectangle(cornerRadius: radius))
                            Text(category.title(model.locale)).font(.subheadline.weight(.semibold))
                              .multilineTextAlignment(.center).frame(maxWidth: .infinity)
                          }
                        }.buttonStyle(.plain).accessibilityIdentifier("category-\(category.id)")
                      }
                    }
                  } else if model.production {
                    CommerceView(shopping: model.shopping, locale: model.locale, tab: tab, toggleLanguage: { Task { await model.toggleLanguage() } }, wishlistEnabled: config.features.wishlist, openHelp: { model.assistantPresented = true }, accountNavigation: { accountScroll.scrollTo("account-top", anchor: .top) }, openProduct: { id in Task { await model.product(id) } }, shop: { model.selectedTab = "categories" })
                    if tab == "account" {
                      StorefrontSettings(model: model)
                    }
                  } else {
                    Image(systemName: icon(tab)).font(.system(size: 44)).foregroundStyle(
                      Color(hex: palette.primary)
                    ).accessibilityHidden(true).padding(.top, 48)
                    Text(label(tab)).font(.title2.bold())
                    Text(
                      model.copy(
                        "Shopping and account features are coming in the next commerce milestone.",
                        "ميزات التسوق والحساب قادمة في المرحلة التالية.")
                    ).font(.body)
                  }
                }.padding(gap).frame(maxWidth: .infinity, alignment: .leading)
                  .padding(.bottom, tab == "account" ? 104 : 0).id("account-top")
              }
              .scrollDismissesKeyboard(.interactively)
              .background(Color(hex: palette.background))
              .foregroundStyle(Color(hex: palette.text))
              .refreshable { await model.load() }
              .safeAreaInset(edge: .top, spacing: 0) { if tab != "account" { storeHeader(config: config, palette: palette) } }
              }
              }
              }
              .navigationTitle("")
              .navigationDestination(isPresented: Binding(get: { tab == "categories" && model.selectedCategory != nil }, set: { if !$0 { model.closeCategory() } })) {
                categoryScreen(palette: palette)
              }
              .navigationBarTitleDisplayMode(.inline)
            }
            .toolbar(.hidden, for: .tabBar)
            .tabItem { Label(label(tab), systemImage: icon(tab)).environment(\.symbolVariants, .none) }
            .tag(tab)
          }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
          bottomBar(config: config, palette: palette)
        }
        .toolbar(.hidden, for: .navigationBar)
          .navigationDestination(isPresented: Binding(
            get: { model.selectedProduct != nil && !quickPurchase },
            set: { if !$0 { model.selectedProduct = nil } }
          )) {
            if let product = model.selectedProduct {
              ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                  productArt(product).font(.system(size: 100)).frame(
                    maxWidth: .infinity, minHeight: 220
                  ).accessibilityHidden(true)
                  Text(product.title(model.locale)).font(.largeTitle.bold())
                    .accessibilityIdentifier("product-detail-title")
                  ProductPriceView(product: product, locale: model.locale).font(.title2.weight(.semibold))
                  Text(product.detail(model.locale)).font(.body)
                  if !model.production || !model.shopping.selectedLocation.isEmpty {
                    Label(
                      product.inStock
                        ? model.copy("Available", "متوفر")
                        : model.copy("Out of stock", "غير متوفر"),
                      systemImage: product.inStock ? "checkmark.circle" : "clock"
                    ).font(.callout)
                  }
                  if model.production && config.features.wishlist && config.screens.product?.showWishlist != false {
                    NativeWishlistSaveButton(shopping: model.shopping, product: product, locale: model.locale) { model.selectedProduct = nil; model.selectedTab = "account" }
                  }
                  if model.production {
                    if let problem = model.problem {
                      Text(problem).foregroundStyle(.red)
                      Button(model.copy("Retry", "إعادة المحاولة")) {
                        Task { await model.product(product.id) }
                      }
                    }
                    if model.shopping.selectedLocation.isEmpty {
                      Text(
                        model.copy(
                          "Choose a covered delivery address to check available sizes and stock.",
                          "اختر عنواناً داخل منطقة التوصيل للتحقق من الأحجام والمخزون."))
                      Button(model.copy("Choose delivery address", "اختيار عنوان التوصيل")) {
                        model.selectedProduct = nil
                        model.selectedTab = "account"
                      }.buttonStyle(.storefrontPrimary).accessibilityIdentifier(
                        "choose-product-address")
                    } else if (product.productType ?? "simple") == "simple" {
                      EmptyView()
                    } else {
                      Text(model.copy("Choose your size or option", "اختر الحجم أو النوع")).font(
                        .headline)
                      ForEach(model.variants) { variant in
                        Button(
                          "\(variant.title(model.locale)) · \(money(variant))"
                        ) { Task { await model.product(variant.id) } }.buttonStyle(.storefrontSecondary)
                          .accessibilityIdentifier("variant-\(variant.id)")
                      }
                    }
                  } else {
                    Text(
                      model.copy(
                        "Product preview · Checkout is not enabled yet",
                        "معاينة المنتج · الدفع غير مفعل بعد")
                    ).font(.footnote).foregroundStyle(.secondary)
                  }
                  if model.production {
                    ProductRelationshipsView(shopping: model.shopping, sources: [product.id], kind: "related", locale: model.locale) { id in Task { await model.product(id) } }
                    ProductRelationshipsView(shopping: model.shopping, sources: [product.id], kind: "upsell", locale: model.locale) { id in Task { await model.product(id) } }
                    if config.screens.product?.showCompare != false { ComparisonControls(shopping: model.shopping, product: product.id, locale: model.locale, openProduct: { id in Task { await model.product(id) } }, openAssistant: { model.assistantPresented = true }) }
                    ReviewsView(shopping: model.shopping, product: product.id, locale: model.locale) { model.selectedProduct = nil; model.selectedTab = "account" }
                  }
                }.padding(24)
              }.background(Color(hex: palette.background)).foregroundStyle(Color(hex: palette.text))
                .safeAreaInset(edge: .bottom, spacing: 0) {
                  VStack(spacing: 0) {
                  if model.production {
                    ProductPurchaseView(shopping: model.shopping, product: product, locale: model.locale, ready: (product.productType ?? "simple") == "simple") {
                      model.selectedProduct = nil; model.selectedTab = "account"
                    }.id(product.id).padding(16).background(Color(hex: palette.background))
                      .overlay(alignment: .top) { Divider() }
                  }
                  bottomBar(config: config, palette: palette)
                  }
                }
                .toolbar(.visible, for: .navigationBar)
                .navigationTitle(model.copy("Product", "المنتج"))
                .navigationBarTitleDisplayMode(.inline)
                .navigationBarBackButtonHidden(true)
                .toolbar {
                  ToolbarItem(placement: .topBarLeading) {
                    Button { model.selectedProduct = nil } label: {
                      Label(model.copy("Back", "رجوع"), systemImage: "chevron.backward")
                    }
                      .accessibilityIdentifier("close-product")
                  }
                }
            }
          }
        }
        .sheet(isPresented: $quickPurchase, onDismiss: { model.selectedProduct = nil }) {
          NavigationStack {
            ScrollView {
              VStack(alignment: .leading, spacing: 20) {
                if let product = model.selectedProduct {
                  productArt(product).frame(height: 180).frame(maxWidth: .infinity)
                  Text(product.title(model.locale)).font(.title2.bold())
                  if let problem = model.problem { Text(problem) }
                  if model.production && model.shopping.selectedLocation.isEmpty {
                    Button(model.copy("Choose delivery address", "اختيار عنوان التوصيل")) {
                      quickPurchase = false; model.selectedProduct = nil; model.selectedTab = "account"
                    }.buttonStyle(.storefrontPrimary)
                  } else if (product.productType ?? "simple") != "simple" {
                    Text(model.copy("Choose your size or option", "اختر الحجم أو النوع")).font(.headline)
                    if model.variants.isEmpty { Text(model.copy("No options are available.", "لا توجد خيارات متاحة.")) }
                    ForEach(model.variants) { variant in
                      Button("\(variant.title(model.locale)) · \(variant.price) \(variant.currency)") {
                        Task { await model.product(variant.id) }
                      }.buttonStyle(.storefrontSecondary)
                    }
                  } else if model.production {
                    ProductPurchaseView(shopping: model.shopping, product: product, locale: model.locale, showsDraftQuantity: true) {
                      quickPurchase = false; model.selectedProduct = nil; model.selectedTab = "account"
                    }.id(product.id)
                  }
                } else if let problem = model.problem { Text(problem) }
                else { ProgressView() }
              }.padding(20)
            }
            .navigationTitle(model.copy("Add to cart", "إضافة إلى السلة"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(model.copy("Done", "تم")) { quickPurchase = false; model.selectedProduct = nil } } }
          }.presentationDetents([.medium, .large])
        }.tint(Color(hex: palette.primary))
      } else {
        ContentUnavailableView("Unable to open this store", systemImage: "exclamationmark.triangle")
      }
    }
    .preferredColorScheme(.light)
    .environment(\.layoutDirection, model.locale == "ar" ? .rightToLeft : .leftToRight)
    .environment(\.locale, Locale(identifier: model.locale))
    .fullScreenCover(isPresented: $model.assistantPresented, onDismiss: {
      if let id = assistantProductToOpen {
        assistantProductToOpen = nil
        Task { await model.product(id) }
      }
    }) {
      AssistantView(chat: model.shopping.assistant, shopping: model.shopping, locale: model.locale,
        close: { model.assistantPresented = false },
        navigate: { destination in model.assistantPresented = false; model.selectedTab = destination },
        openProduct: { id in
          assistantProductToOpen = id
          model.assistantPresented = false
        })
        .tint(palette.map { Color(hex: $0.primary) } ?? .accentColor)
    }
    .environment(\.storefrontButtonTheme, StorefrontButtonTheme(
      radius: radius,
      primary: palette.map { Color(hex: $0.primary) } ?? .accentColor,
      onPrimary: palette.map { Color(hex: $0.onPrimary) } ?? .white,
      background: palette.map { Color(hex: $0.background) } ?? .white,
      surface: palette.map { Color(hex: $0.surface) } ?? .white,
      text: palette.map { Color(hex: $0.text) } ?? .primary))
    .task { await model.load(); if orderPush.pendingOrder != nil { model.selectedTab = "account" } }
    .task(id: headerShopping.customer?.id) { await orderPush.session(headerShopping.customer?.id) }
    .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in Task { await orderPush.refresh() } }
    .onChange(of: orderPush.pendingOrder) { _, value in if value != nil { model.selectedProduct = nil; model.selectedTab = "account" } }
  }
  @ViewBuilder private func render(
    _ section: RocentoCore.Section, config: MobileConfig, palette: Palette
  ) -> some View {
    switch section {
    case .heroBanner(let hero):
      if hero.props.layout != nil {
        VStack(spacing: 0) {
          bannerGallery(hero, config: config, palette: palette)
          if let appearance = hero.props.appearance {
            editorialCopy(config: config, palette: palette, heading: hero.props.headingKey, body: hero.props.bodyKey, eyebrow: hero.props.eyebrowKey, label: hero.props.labelKey, action: hero.props.action, path: hero.props.storefrontPath, campaign: appearance.rawValue == "campaign")
          }
        }
      } else if let appearance = hero.props.appearance {
        VStack(spacing: 0) {
          if let image = model.decodedBrandAssets[hero.props.imageAssetId] {
            Image(uiImage: image).resizable().scaledToFit().accessibilityLabel(config.text(hero.props.accessibilityLabelKey, locale: model.locale))
          }
          editorialCopy(config: config, palette: palette, heading: hero.props.headingKey, body: hero.props.bodyKey, eyebrow: hero.props.eyebrowKey, label: hero.props.labelKey, action: hero.props.action, path: hero.props.storefrontPath, campaign: appearance.rawValue == "campaign")
        }.background(Color(hex: appearance.rawValue == "campaign" ? palette.surface : palette.background)).clipShape(RoundedRectangle(cornerRadius: radius)).accessibilityIdentifier("hero-\(hero.id)")
      } else { Button {
        Task { await model.open(hero.props.action) }
      } label: {
        VStack(alignment: .leading, spacing: 20) {
          HStack {
            if let image = model.decodedBrandAssets[hero.props.imageAssetId]
            {
              Image(uiImage: image).resizable().scaledToFit().frame(maxWidth: .infinity).frame(height: 96)
            } else {
              Image(systemName: model.merchant == 1 ? "leaf.fill" : "bag.fill").font(
                .system(size: 46))
            }
            SwiftUI.Spacer()
            Image(systemName: "arrow.up.forward").font(.title2)
          }.accessibilityHidden(true)
          Text(
            model.merchant == 1
              ? model.copy("A little fresher.\nA little better.", "طازج أكثر.\nأفضل كل يوم.")
              : model.copy("Good things,\nfound here.", "أشياء جميلة،\nتجدها هنا.")
          ).font(.largeTitle.weight(.semibold))
          Text(model.copy("Explore the collection", "استكشف المجموعة")).font(
            .callout.weight(.semibold))
        }.frame(maxWidth: .infinity, alignment: .leading).padding(24).foregroundStyle(
          Color(hex: palette.onPrimary)
        ).background(Color(hex: palette.primary), in: RoundedRectangle(cornerRadius: radius))
      }.buttonStyle(.plain).accessibilityLabel(
        config.text(hero.props.accessibilityLabelKey, locale: model.locale)
      ).accessibilityHint(model.copy("Opens the featured collection", "يفتح المجموعة المختارة"))
        .accessibilityIdentifier("hero-\(hero.id)") }
    case .productCarousel(let section):
      Text(config.text(section.props.titleKey, locale: model.locale)).font(.title2.bold())
        .accessibilityAddTraits(.isHeader)
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(alignment: .top, spacing: gap) {
          ForEach(Array((model.collections[section.props.collectionId] ?? []).prefix(section.props.limit ?? 24))) { product in
            productCard(product, palette: palette).frame(
              width: textSize.isAccessibilitySize ? 260 : 180)
          }
        }
      }
    case .productGrid(let section):
      Text(config.text(section.props.titleKey, locale: model.locale)).font(.title2.bold())
      productGrid(
        palette: palette, products: Array((model.collections[section.props.collectionId] ?? []).prefix(section.props.limit ?? 24)),
        columns: section.props.columns)
    case .categoryGrid(let section):
      Text(config.text(section.props.titleKey, locale: model.locale)).font(.title2.bold())
      if section.props.appearance?.rawValue == "tiles" {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: textSize.isAccessibilitySize ? 1 : 2), spacing: 12) {
          ForEach(section.props.categoryIds.compactMap { id in model.categories.first { $0.id == id || $0.slug == id } }) { category in
            Button { Task { await model.category(category.id) } } label: {
              VStack(alignment: .leading, spacing: 8) {
                if let thumbnail = category.thumbnail { MerchantImage(url: model.shopping.client.imageURL(thumbnail)).aspectRatio(1, contentMode: .fit).clipShape(RoundedRectangle(cornerRadius: radius)) }
                Text(category.title(model.locale)).font(.system(size: 14, weight: .semibold))
              }.frame(maxWidth: .infinity, alignment: .leading)
            }.buttonStyle(.plain).accessibilityIdentifier("category-\(category.id)")
          }
        }
      } else {
        ForEach(model.categories.filter { section.props.categoryIds.contains($0.id) || section.props.categoryIds.contains($0.slug) }) { category in
          Button(category.title(model.locale)) { Task { await model.category(category.id) } }.frame(minHeight: 48)
        }
      }
    case .richText(let section):
      if let appearance = section.props.appearance {
        editorialCopy(config: config, palette: palette, heading: section.props.headingKey, body: section.props.bodyKey, eyebrow: section.props.eyebrowKey, label: section.props.labelKey, action: section.props.action, path: section.props.storefrontPath, campaign: appearance.rawValue == "campaign", textKey: section.props.textKey)
          .background(Color(hex: appearance.rawValue == "campaign" ? palette.surface : palette.background)).clipShape(RoundedRectangle(cornerRadius: radius))
      } else { Text(config.text(section.props.textKey, locale: model.locale)).font(.body) }
    case .spacer(let section):
      Color.clear.frame(
        height: section.props.size.rawValue == "small"
          ? 8 : section.props.size.rawValue == "large" ? 32 : 16
      ).accessibilityHidden(true)
    }
  }
  private func bannerGallery(_ hero: HeroBanner, config: MobileConfig, palette: Palette) -> some View {
    let ids = [hero.props.imageAssetId] + (hero.props.additionalImageAssetIds ?? [])
    let portrait = hero.props.layout?.rawValue == "portrait"
    let ratio: CGFloat = portrait ? 2.0 / 3.0 : 3.0
    let fraction: CGFloat = ids.count > 1 ? (portrait ? 0.78 : 0.88) : 1
    return GeometryReader { proxy in
      let width = proxy.size.width * fraction
      ScrollView(.horizontal) {
        LazyHStack(spacing: 12) {
          ForEach(Array(ids.enumerated()), id: \.offset) { index, id in
            Button { Task { await model.open(hero.props.action) } } label: {
              ZStack {
                Color(hex: palette.surface)
                if let image = model.decodedBrandAssets[id] {
                  Image(uiImage: image).resizable()
                    .aspectRatio(contentMode: hero.props.imageFit?.rawValue == "contain" ? .fit : .fill)
                }
              }.frame(width: width, height: width / ratio).clipped()
                .clipShape(RoundedRectangle(cornerRadius: radius))
            }.buttonStyle(.plain)
              .accessibilityLabel(config.text(hero.props.accessibilityLabelKey, locale: model.locale) + " · \(index + 1)")
          }
        }.padding(.horizontal, (proxy.size.width - width) / 2).scrollTargetLayout()
      }.scrollTargetBehavior(.viewAligned).defaultScrollAnchor(portrait && ids.count >= 3 ? .center : .leading)
    }.aspectRatio(ratio / fraction, contentMode: .fit).accessibilityIdentifier("hero-\(hero.id)")
  }

  private func bottomBar(config: MobileConfig, palette: Palette) -> some View {
    VStack(spacing: 0) {
      Divider()
      HStack(spacing: 0) {
        ForEach(config.navigation.tabs.map(\.rawValue), id: \.self) { tab in
          Button { model.selectedProduct = nil; model.selectedTab = tab } label: {
            VStack(spacing: 4) {
              Image(systemName: icon(tab))
                .font(.system(size: 22)).environment(\.symbolVariants, .none)
              Text(label(tab)).font(.caption2).multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity, minHeight: 52)
            .padding(.vertical, 4)
            .contentShape(Rectangle())
            .foregroundStyle(Color(hex: model.selectedTab == tab ? palette.primary : palette.text))
          }
          .buttonStyle(.plain)
          .accessibilityLabel(label(tab))
          .accessibilityIdentifier("tab-\(tab)")
          .accessibilityAddTraits(model.selectedTab == tab ? .isSelected : [])
        }
      }
    }
    .frame(maxWidth: .infinity)
    .background(Color(hex: palette.surface).ignoresSafeArea(edges: .bottom))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("bottom-navigation")
  }
  private func editorialCopy(config: MobileConfig, palette: Palette, heading: String?, body: String?, eyebrow: String?, label: String?, action: Action?, path: String?, campaign: Bool, textKey: String? = nil) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      if let eyebrow { Text(config.text(eyebrow, locale: model.locale)).font(.caption2).tracking(model.locale == "ar" ? 0 : 1.6) }
      if let heading { Text(config.text(heading, locale: model.locale)).font(.title.weight(.medium)).fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader) }
      if let body { Text(config.text(body, locale: model.locale)).font(.subheadline).lineSpacing(5).fixedSize(horizontal: false, vertical: true) }
      if let textKey { Text(config.text(textKey, locale: model.locale)).font(heading == nil ? .title.weight(.medium) : .subheadline).lineSpacing(5).fixedSize(horizontal: false, vertical: true) }
      if let label, action != nil || path != nil {
        Button { if path == "/assistant" && model.production { model.assistantPresented = true } else if let path, let url = URL(string: path, relativeTo: model.identity.commerceBaseURL)?.absoluteURL { openURL(url) } else if let action { Task { await model.open(action) } } } label: {
          Text(config.text(label, locale: model.locale) + " ↗").font(.footnote).underline().padding(.vertical, 8)
        }.buttonStyle(.plain).foregroundStyle(Color(hex: palette.primary))
      }
    }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, campaign ? 18 : 12).padding(.vertical, campaign ? 26 : 24)
  }
  private func money(_ product: Product, amount: String? = nil) -> String {
    CommercePresentation.money(amount ?? product.displayPrice, currency: product.currency, locale: model.locale)
  }
  private func categoryScreen(palette: Palette) -> some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        Button { filterDraft = model.categoryFilters; categoryFiltersPresented = true } label: {
          Label(model.copy("Filter & sort", "تصفية وترتيب"), systemImage: "slider.horizontal.3")
        }.buttonStyle(.storefrontSecondary)
        let parent = model.categories.first { $0.id == model.selectedCategory || $0.slug == model.selectedCategory }
        let children = model.categories.filter { parent != nil && $0.parent_id == parent?.id }
        if !children.isEmpty {
          ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
              ForEach(children) { category in
                Button(category.title(model.locale)) { Task { await model.category(category.id) } }
                  .buttonStyle(.storefrontSecondary)
              }
            }
          }.accessibilityIdentifier("subcategory-slider")
        }
        if model.categoryLoading { ProgressView().accessibilityLabel(model.copy("Loading products", "جارٍ تحميل المنتجات")) }
        if let error = model.categoryError {
          Text(error)
          Button(model.copy("Retry", "إعادة المحاولة")) { Task { await model.browseCategory(more: !model.categoryProducts.isEmpty) } }
        }
        Text("\(model.categoryTotal) " + model.copy("products", "منتج"))
        if !model.categoryLoading && model.categoryError == nil && model.categoryProducts.isEmpty { Text(model.copy("No products match. Try resetting the filters.", "لا توجد منتجات مطابقة. جرّب إعادة تعيين الفلاتر.")) }
        productGrid(palette: palette, products: model.categoryProducts)
        if model.categoryHasMore {
          Button(model.copy("Load more products", "عرض المزيد من المنتجات")) { Task { await model.browseCategory(more: true) } }.disabled(model.categoryLoading)
        }
      }.padding(gap)
    }
    .background(Color(hex: palette.background))
    .sheet(isPresented: $categoryFiltersPresented) {
      NavigationStack {
        ScrollView {
          VStack(alignment: .leading, spacing: 20) {
          HStack {
            Text(model.copy("Refine your results", "حدد النتائج المناسبة")).font(.caption).foregroundStyle(.secondary)
            SwiftUI.Spacer()
            Button(model.copy("Reset", "إعادة تعيين")) { filterDraft = CatalogFilters() }
          }
          TextField(model.copy("Search products", "البحث عن المنتجات"), text: $filterDraft.query)
            .textFieldStyle(.roundedBorder).accessibilityIdentifier("category-query")
          Picker(model.copy("Sort by", "ترتيب حسب"), selection: $filterDraft.sort) {
            Text(model.copy("Relevance", "الأكثر صلة")).tag("relevance")
            Text(model.copy("Price: low to high", "السعر: الأقل أولاً")).tag("price_asc")
            Text(model.copy("Price: high to low", "السعر: الأعلى أولاً")).tag("price_desc")
            Text(model.copy("Name: A–Z", "الاسم: تصاعدياً")).tag("name_asc")
            Text(model.copy("Name: Z–A", "الاسم: تنازلياً")).tag("name_desc")
            ForEach(model.categoryAttributes.filter { $0.metadata?.sortable == true && !["name", "price"].contains($0.id) }) { attribute in
              Text(attribute.label + model.copy(": ascending", ": تصاعدياً")).tag(attribute.id + ":asc")
              Text(attribute.label + model.copy(": descending", ": تنازلياً")).tag(attribute.id + ":desc")
            }
          }
          let priceLimit = max(10_000, Double(filterDraft.minimum) ?? 0, Double(filterDraft.maximum) ?? 0)
          VStack(alignment: .leading) {
            Text(model.copy("Min price", "أقل سعر") + ": " + (filterDraft.minimum.isEmpty ? "0" : filterDraft.minimum))
            Slider(value: Binding(get: { Double(filterDraft.minimum) ?? 0 }, set: { value in
              let price = min(value, Double(filterDraft.maximum) ?? priceLimit)
              filterDraft.minimum = price == 0 ? "" : String(Int(price))
            }), in: 0...priceLimit, step: 1)
              .accessibilityLabel(model.copy("Min price", "أقل سعر")).accessibilityIdentifier("category-min")
            Text(model.copy("Max price", "أعلى سعر") + ": " + (filterDraft.maximum.isEmpty ? model.copy("Any price", "أي سعر") : filterDraft.maximum))
            Slider(value: Binding(get: { Double(filterDraft.maximum) ?? priceLimit }, set: { value in
              let price = max(value, Double(filterDraft.minimum) ?? 0)
              filterDraft.maximum = price == priceLimit ? "" : String(Int(price))
            }), in: 0...priceLimit, step: 1)
              .accessibilityLabel(model.copy("Max price", "أعلى سعر"))
              .accessibilityValue(filterDraft.maximum.isEmpty ? model.copy("Any price", "أي سعر") : filterDraft.maximum)
              .accessibilityIdentifier("category-max")
          }
          Toggle(model.copy("In stock only", "المتوفر فقط"), isOn: $filterDraft.inStock)
          ForEach(model.categoryAttributes.filter { $0.showsFilter(facets: model.categoryFacets[$0.id] ?? [:], selected: filterDraft.attributes[$0.id] ?? []) }) { attribute in
            let selected = filterDraft.attributes[attribute.id] ?? []
            let choices = attribute.choices(facets: model.categoryFacets[attribute.id] ?? [:], selected: selected)
            DisclosureGroup(attribute.label) {
              if attribute.usesChoices {
                ForEach(choices, id: \.self) { value in
                  Toggle(attribute.options.first { $0.value == value }?.label ?? (attribute.input_type == "boolean" ? (value == "true" ? model.copy("Yes", "نعم") : model.copy("No", "لا")) : value), isOn: Binding(get: { selected.contains(value) }, set: { checked in
                    filterDraft.attributeTypes[attribute.id] = attribute.input_type
                    let values = checked ? selected + [value] : selected.filter { $0 != value }
                    filterDraft.attributes[attribute.id] = values.isEmpty ? nil : values
                  }))
                }
              } else {
                TextField(attribute.label, text: Binding(get: { selected.first ?? "" }, set: { value in
                  filterDraft.attributeTypes[attribute.id] = attribute.input_type
                  filterDraft.attributes[attribute.id] = value.isEmpty ? nil : [value]
                })).textFieldStyle(.roundedBorder)
              }
            }
          }
          if !filterDraft.valid { Text(model.copy("Enter a valid price range.", "أدخل نطاق أسعار صالحاً.")).foregroundStyle(.red) }
          }.padding(20)
        }
        .safeAreaInset(edge: .bottom) {
          Button { model.categoryFilters = filterDraft; categoryFiltersPresented = false; Task { await model.browseCategory() } } label: {
            Text(model.copy("Show results", "عرض النتائج")).font(.headline).frame(maxWidth: .infinity)
          }.buttonStyle(.storefrontPrimary).disabled(!filterDraft.valid).padding(16).background(Color(hex: palette.background))
        }
        .navigationTitle(model.copy("Filter & sort", "تصفية وترتيب")).navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button(model.copy("Done", "تم")) { categoryFiltersPresented = false } } }
      }.environment(\.layoutDirection, model.locale == "ar" ? .rightToLeft : .leftToRight)
    }
    .navigationTitle(model.categories.first { $0.id == model.selectedCategory || $0.slug == model.selectedCategory }?.title(model.locale) ?? model.copy("Search results", "نتائج البحث"))
    .navigationBarTitleDisplayMode(.inline)
    .refreshable { await model.browseCategory() }
  }
  private func productGrid(palette: Palette, products: [Product]? = nil, columns: Int = 2)
    -> some View
  {
    LazyVGrid(
      columns: Array(
        repeating: GridItem(.flexible()), count: textSize.isAccessibilitySize ? 1 : columns),
      alignment: .leading, spacing: gap
    ) { ForEach(products ?? model.products) { product in productCard(product, palette: palette) } }
  }
  private func productCard(_ product: Product, palette: Palette) -> some View {
    VStack(alignment: .leading, spacing: 8) {
    Button {
      Task { await model.product(product.id) }
    } label: {
      VStack(alignment: .leading, spacing: 12) {
        productArt(product).font(.system(size: 60)).frame(maxWidth: .infinity).frame(height: 150)
          .clipShape(RoundedRectangle(cornerRadius: radius))
          .accessibilityHidden(true)
        Text(product.title(model.locale)).font(.headline).fixedSize(
          horizontal: false, vertical: true)
        Text(money(product)).font(.subheadline.weight(.semibold))
        if product.displayPrice != product.price {
          Text(money(product, amount: product.price)).font(.caption).strikethrough().foregroundStyle(.secondary)
            .accessibilityLabel(model.copy("Original price ", "السعر الأصلي ") + money(product, amount: product.price))
          if let original = Decimal(string: product.price), let offer = Decimal(string: product.displayPrice) {
            Text(model.copy("Save ", "وفّر ") + money(product, amount: NSDecimalNumber(decimal: original - offer).stringValue))
              .font(.caption.weight(.semibold)).foregroundStyle(.tint)
          }
        }
      }.frame(maxWidth: .infinity, alignment: .leading)
    }.buttonStyle(.plain).accessibilityElement(children: .combine).accessibilityIdentifier(
      "product-\(product.id)")
      Button {
        model.selectedProduct = nil; model.problem = nil; quickPurchase = true
        Task { await model.product(product.id) }
      } label: { Image(systemName: "cart").frame(minWidth: 44, minHeight: 44) }
        .buttonStyle(.plain)
        .accessibilityLabel(model.copy("Add to cart: ", "إضافة إلى السلة: ") + product.title(model.locale))
        .accessibilityIdentifier("quick-add-\(product.id)")
    }
  }
  @ViewBuilder private func productArt(_ product: Product) -> some View {
    if model.production {
      MerchantImage(url: product.thumbnail.flatMap { model.shopping.client.imageURL($0) })
    } else {
      Text(
        ["apple": "🍎", "avocado": "🥑", "bread": "🍞", "bag": "👜", "shirt": "👕", "cup": "☕️"][
          product.symbol ?? ""] ?? "📦")
    }
  }
  private func storeHeader(config: MobileConfig, palette: Palette) -> some View {
    VStack(spacing: 10) {
      HStack(spacing: 12) {
        Button { deliveryLocationPresented = true } label: {
          HStack(spacing: 6) {
            Image(systemName: "mappin.and.ellipse")
            VStack(alignment: .leading, spacing: 2) {
              Text(model.copy("Deliver to", "التوصيل إلى")).font(.caption2)
              if let address = headerShopping.locations.first(where: { $0.id == headerShopping.selectedLocation })?.formatted_address ?? headerShopping.session.delivery.state.guestAddress {
                Text(address).font(.subheadline.weight(.semibold)).lineLimit(1)
              }
            }.frame(maxWidth: .infinity, alignment: .leading)
          }.frame(minHeight: 44)
        }.accessibilityIdentifier("header-location")
          .sheet(isPresented: $deliveryLocationPresented) { AddressView(shopping: model.shopping, locale: model.locale) }
        Button { model.selectedTab = "account"; model.shopping.session.navigation.open("notifications") } label: {
          Image(systemName: "bell").frame(minWidth: 44, minHeight: 44)
        }.accessibilityLabel(model.copy("Notifications", "الإشعارات")).accessibilityIdentifier("open-notifications")
        if model.production {
          Button { model.assistantPresented = true } label: {
            Image(systemName: "bubble.left").frame(minWidth: 44, minHeight: 44)
          }.accessibilityLabel(model.copy("Shopping assistant", "مساعد التسوق")).accessibilityIdentifier("open-assistant")
        }
      }
      HStack {
        Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
        TextField(model.copy("Search products", "البحث عن المنتجات"), text: $searchQuery)
          .submitLabel(.search).onSubmit { Task { await model.search(searchQuery) } }.accessibilityIdentifier("header-search")
        if !searchQuery.isEmpty {
          Button { Task { await model.search(searchQuery) } } label: { Image(systemName: "arrow.forward") }
            .accessibilityLabel(model.copy("Search", "بحث"))
        }
      }.padding(12).background(Color(hex: palette.background), in: RoundedRectangle(cornerRadius: 14))
    }.padding(.horizontal, 16).padding(.vertical, 8).background(Color.white)
  }
  private func dealsContent(palette: Palette) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      Text(model.copy("Deals", "العروض")).font(.largeTitle.bold())
      Text(model.copy("Current offers, with savings shown upfront.", "عروض حالية مع توضيح قيمة التوفير."))
      Text(model.copy("Final prices and eligibility are confirmed at checkout.", "يتم تأكيد الأسعار النهائية وشروط الاستحقاق عند إتمام الطلب.")).font(.caption).foregroundStyle(.secondary)
      productGrid(palette: palette, products: dealProducts)
      if dealsLoading { ProgressView().accessibilityIdentifier("deals-loading") }
      if dealsFailed { Text(model.copy("Unable to load deals. Please retry.", "تعذر تحميل العروض. يرجى المحاولة.")).accessibilityIdentifier("deals-error") }
      if !dealsLoading && !dealsFailed && dealProducts.isEmpty {
        Text(dealsHaveMore ? model.copy("No offers in these products. Explore more below.", "لا توجد عروض في هذه المنتجات. استكشف المزيد أدناه.") : model.copy("No deals available right now", "لا توجد عروض حالياً")).accessibilityIdentifier("deals-empty")
      }
      if dealsHaveMore || dealsFailed {
        Button(dealsFailed ? model.copy("Retry", "إعادة المحاولة") : model.copy("Explore more deals", "استكشف المزيد من العروض")) { Task { await loadDeals() } }.disabled(dealsLoading)
      }
    }.task(id: model.locale) {
      dealProducts = []; dealOffset = 0; dealsHaveMore = true
      await loadDeals()
    }
  }
  @MainActor private func loadDeals() async {
    guard !dealsLoading else { return }
    dealsLoading = true; dealsFailed = false
    let language = model.locale
    defer { dealsLoading = false }
    do {
      let targetCount = dealProducts.count + 12
      // Bound each scan while skipping pages with no eligible catalog offers.
      for _ in 0..<10 {
        let page = try await model.catalog.browse(category: "", filters: CatalogFilters(), offset: dealOffset, locale: language)
        try Task.checkCancellation()
        guard model.locale == language else { return }
        for product in page.hits where product.active != false && product.displayPrice != product.price {
          if !dealProducts.contains(where: { $0.id == product.id }) { dealProducts.append(product) }
        }
        dealOffset += page.hits.count
        dealsHaveMore = !page.hits.isEmpty && dealOffset < page.total && dealOffset <= 9999
        if !dealsHaveMore || dealProducts.count >= targetCount { break }
      }
    } catch is CancellationError { } catch { dealsFailed = true }
  }
  private func icon(_ tab: String) -> String {
    let name = model.config?.navigation.icons?[tab]?.rawValue ?? tab
    return [
      "home": "house", "categories": "square.grid.2x2", "cart": "cart", "deals": "tag",
      "account": "person.crop.circle", "wishlist": "heart", "location": "mappin.and.ellipse",
    ][name] ?? "circle"
  }
  private func label(_ tab: String) -> String {
    model.locale == "ar"
      ? [
        "home": "الرئيسية", "categories": "الأقسام", "cart": "السلة", "account": "الحساب",
        "wishlist": "المفضلة", "deals": "العروض",
      ][tab] ?? tab : tab.capitalized
  }
}


