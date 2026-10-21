import { LanguageSwitcher, useInterface } from './interface-locale';
import { InterfaceProvider } from "./interface-locale";
import { startStorefront } from "./storefront-bootstrap";
import { InstallApp, deferInstallManifest } from "./install-app";
import { CheckoutLoading } from "./checkout-loading";
import { ComparisonProvider, ComparisonPage, ComparisonTray } from "./comparison";
import { AuthContext } from "./auth-context";
import { ProductLoading } from "./product-loading";
import { mediaUrl } from "@commerce/api-client";
import { ThemeProvider, ThemeGlobal, ThemePageView, useTheme, themeOptions } from "./themes";
import { ManagedContent, ContentPage } from "./content";
import { Wishlist, WishlistLink } from "./community";
import { NotificationProvider } from "./notifications";
import { StorefrontNotificationBell } from './storefront-notifications';
import { DeliveryLocationPage, LocationBar } from "./locations";
import { CartProvider, CartLink, CartPage, StoreMarketLabel } from "./cart";
import {
  SearchBar,
  CategoryNav,
  BrowseAnalytics,
} from "./catalog";
import React, {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import ReactDOM from "react-dom/client";
import {
  BrowserRouter,
  Routes,
  Route,
  Link,
  Navigate,
  useLocation,
} from "react-router-dom";
import {
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  customerApi,
  ApiError,
  type Customer,
} from "@commerce/api-client";
import { BrandLogo, Notice, useAction } from "@commerce/ui";
import "@commerce/ui/styles.css";
import "./style.css";
import "./mobile-navigation.css";
// Keep route-only forms, filters and product detail code out of the homepage.
const Browse = lazy(() => import('./catalog-pages').then(module => ({default: module.Browse})));
const ProductDetail = lazy(() => import('./catalog-pages').then(module => ({default: module.ProductDetail})));
const SupportForm = lazy(() => import('./support').then(module => ({default: module.SupportForm})));
const CustomerTickets = lazy(() => import('./support').then(module => ({default: module.CustomerTickets})));
const AuthForm = lazy(() => import('./account-pages').then(module => ({default: module.AuthForm})));
const Challenge = lazy(() => import('./account-pages').then(module => ({default: module.Challenge})));
const Account = lazy(() => import('./account-pages').then(module => ({default: module.Account})));
const AccountFrame = lazy(() => import('./account-pages').then(module => ({default: module.AccountFrame})));
const Locations = lazy(() => import('./account-pages').then(module => ({default: module.Locations})));
const NewLocation = lazy(() => import('./account-pages').then(module => ({default: module.NewLocation})));
const Assistant = lazy(() => import("./assistant").then(module => ({default: module.Assistant})));
const loadCheckout = () => import("./checkout").then(module => ({default: module.Checkout}));
const Checkout = lazy(loadCheckout);
deferInstallManifest();
// Start the route download alongside theme/session requests on direct entry.
// The lazy boundary owns loading errors; other routes keep checkout split.
if (window.location.pathname === "/checkout") void loadCheckout().catch(() => {});
const Orders = lazy(() => import("./orders").then(module => ({default: module.Orders})));
const OrderPage = lazy(() => import("./orders").then(module => ({default: module.OrderPage})));
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});
queryClient.setQueryDefaults(["categories"], { staleTime: 30_000 });
const initialSession = startStorefront(queryClient, window.location.pathname, (url, responsive) => {
  const image = new Image();
  image.fetchPriority = "high";
  if (responsive) {
    image.sizes = responsive.sizes;
    image.srcset = responsive.srcSet;
  }
  image.src = url;
});
function HeaderIcon({ name }: { name: "assistant" | "support" | "account" | "search" | "wishlist" }) {
  const paths: Record<typeof name, ReactNode> = {
    wishlist: <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>,
    assistant: <><path d="m12 3 1.2 4.2L17 9l-3.8 1.8L12 15l-1.2-4.2L7 9l3.8-1.8Z"/><path d="M19 15l.6 1.8 1.9.7-1.9.7L19 20l-.6-1.8-1.9-.7 1.9-.7Z"/></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
    support: <><path d="M4 12a8 8 0 0 1 16 0v5a3 3 0 0 1-3 3h-2"/><path d="M4 13h3v5H4zM17 13h3v5h-3z"/><path d="M12 20h3"/></>,
    account: <><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></>,
  };
  return <svg className="header-icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}
function App() {
  const { message } = useInterface();
  const { t: ui } = useInterface();
  const theme = useTheme();
  const headerOptions = themeOptions(theme, 'header_options', 'top');
  const heritage = theme.global.top.some(s => s.enabled && s.component === "presentation" && s.settings.style === "heritage");
  const showcase = theme.global.top.some(s => s.enabled && s.component === "presentation" && s.settings.style === "showcase");
  const grocery = !theme.global.top.some(s => s.enabled && s.component === "presentation" && ['heritage', 'showcase', 'editorial'].includes(String(s.settings.style)));
  const mobileAssistant = headerOptions.show_assistant === 'on' && !grocery && !heritage;
  const compactHeader = heritage || showcase;
  const configuredBrand = String(theme.global.top.find(s => s.enabled && s.component === "header")?.settings.brand || "Rocento");
  const brand = /^rocento\s+tech$/i.test(configuredBrand.trim()) ? "rocento" : configuredBrand;
  const [searchOpen, setSearchOpen] = useState(false);
  const route = useLocation();
  useEffect(() => setSearchOpen(false), [route.pathname]);
  const assistantPage = route.pathname === "/assistant";
  const checkoutPage = route.pathname === "/checkout" || (["/login", "/register", "/verify"].includes(route.pathname) && new URLSearchParams(route.search).get("next") === "checkout");
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState("");
  const themeCustomer = useRef<string>();
  useEffect(() => {
    if (!ready || themeCustomer.current === customer?.id) return;
    themeCustomer.current = customer?.id;
    window.dispatchEvent(new Event('commerce-theme-session'));
  }, [customer?.id, ready]);
  useEffect(() => {
    let active = true;
    initialSession.then(({ customer: restored, error }) => {
      if (!active) return;
      setCustomer(restored);
      if (error && (!(error instanceof ApiError) || error.status !== 401)) {
        setBootError("Account service unavailable. Please reload to try again.");
      }
      setReady(true);
    });
    return () => {
      active = false;
    };
  }, []);
  const action = useAction();
  const signOut = () => action.run(async () => {
    await customerApi.logout();
    queryClient.clear();
    setCustomer(null);
  });
  return (
    <AuthContext.Provider value={{ customer, setCustomer }}>
      <CartProvider customerId={customer?.id} ready={ready}>
        <div id="store-top" className={`store-shell${assistantPage ? " assistant-store-shell" : ""}${checkoutPage ? " checkout-store-shell" : ""}`} data-presentation={String(theme.global.top.find(s => s.enabled && s.component === "presentation")?.settings.style || "standard")}>
          <ComparisonTray />
          {!assistantPage && !checkoutPage && <ThemeGlobal location="top" navigation={<CategoryNav />} header={<header className="store-header" data-search-open={searchOpen}>
            <Link to="/" className="brand" aria-label={ui("checkout.brand_home", "{brand} home", {brand:compactHeader?brand:"Rocento"})}>
              {headerOptions.image ? <img className="header-custom-logo" src={mediaUrl(String(headerOptions.image))} alt={String(headerOptions.alt)} style={{ width: Number(headerOptions.logo_width) }} /> : compactHeader ? <span className={heritage ? "heritage-wordmark" : "showcase-wordmark"}>{brand}</span> : <BrandLogo />}
            </Link>
            {heritage && <div className="header-left-tools">
              {ready && headerOptions.show_location === 'on' && <div className="header-delivery-zone"><LocationBar customer={customer} /></div>}
              <button className="header-link icon-control" aria-label={ui("storefront.search", "Search")} aria-expanded={searchOpen} aria-controls="header-search" onClick={() => setSearchOpen(open => !open)}><HeaderIcon name="search"/></button>
            </div>}
            {showcase && ready && headerOptions.show_location === 'on' && <div className="header-delivery-zone"><LocationBar customer={customer} /></div>}
            {showcase && <nav className="showcase-header-links" aria-label={ui("storefront.main", "Main")}><Link to="/search">{ui("storefront.shop_all", "Shop all")}</Link><Link to="/support">{ui("storefront.support", "Support")}</Link></nav>}
            <div id="header-search" className="header-search-zone" hidden={compactHeader && !searchOpen}>
              <SearchBar />
              <div className="header-delivery-tools">
                {!compactHeader && ready && headerOptions.show_location === 'on' && <LocationBar customer={customer} />}
              </div>
            </div>
            <nav aria-label={ui("storefront.shopper_tools", "Shopper tools")}>
              <LanguageSwitcher />
              {!compactHeader && <button className="header-link icon-control mobile-search-toggle" aria-label={ui("storefront.search", "Search")} aria-expanded={searchOpen} aria-controls="header-search" onClick={() => setSearchOpen(open => !open)}><HeaderIcon name="search"/></button>}
              {compactHeader && <>
                <details className="header-account-menu">
                  <summary className="header-link icon-control header-action" aria-label={ui("navigation.account", "My account")} title={ui("navigation.account", "My account")}><HeaderIcon name="account"/></summary>
                  <div className="header-account-options">
                    <StoreMarketLabel/>
                    <Link to={customer ? "/account" : "/login"}>{customer ? ui("navigation.account", "My account") : ui("navigation.sign_in", "Sign in")}</Link>
                    {customer ? <button className="text-button" disabled={action.busy} onClick={signOut}>{ui("navigation.sign_out", "Sign out")}</button> : <Link to="/register">{ui("storefront.create_account", "Create account")}</Link>}
                    <Link to="/assistant">{ui("storefront.shopping_assistant", "Shopping assistant")}</Link>
                    <Link to="/support">{ui("storefront.support", "Support")}</Link>
                  </div>
                </details>
                {!heritage && <button className="header-link icon-control" aria-label={ui("storefront.search", "Search")} aria-expanded={searchOpen} aria-controls="header-search" onClick={() => setSearchOpen(open => !open)}><HeaderIcon name="search"/></button>}
              </>}
              <StorefrontNotificationBell customerId={customer?.id} ready={ready && !bootError} />
              <CartLink iconOnly />
              <WishlistLink customer={customer} />
              {!compactHeader && <details className="header-account-menu">
                <summary className="header-link icon-control header-action" aria-label={ui("navigation.account", "My account")} title={ui("navigation.account", "My account")}><HeaderIcon name="account"/></summary>
                <div className="header-account-options" onClick={event => {
                  if ((event.target as HTMLElement).closest('a,button')) event.currentTarget.closest('details')?.removeAttribute('open');
                }}>
                  <Link to={customer ? "/account" : "/login"}>{customer ? ui("navigation.account", "My account") : ui("navigation.sign_in", "Sign in")}</Link>
                  <StoreMarketLabel/>
                  {!customer && <Link to="/register">{ui("storefront.create_account", "Create account")}</Link>}
                  <Link to="/assistant"><HeaderIcon name="assistant"/>{ui("storefront.shopping_assistant", "Shopping assistant")}</Link>
                  <Link to="/support"><HeaderIcon name="support"/>{ui("storefront.support", "Support")}</Link>
                  {customer && <button className="text-button" disabled={action.busy} onClick={signOut}>{ui("navigation.sign_out", "Sign out")}</button>}
                </div>
              </details>}

            </nav>
          </header>} />}
          {ready && <BrowseAnalytics key={customer?.id || 'guest'} />}
          <Notice error>{message((bootError || action.error) || '')}</Notice>
          {!ready ? (
            route.pathname === "/checkout" ? <CheckoutLoading /> : route.pathname.startsWith("/products/") ? <ProductLoading /> : <main className="storefront-page-loading" aria-busy="true">
              <p role="status">{ui("storefront.loading_your_account", "Loading your account…")}</p>
            </main>
          ) : (
            <Suspense fallback={route.pathname === "/checkout" ? <CheckoutLoading /> : route.pathname.startsWith("/products/") ? <ProductLoading /> : <main className="storefront-page-loading" aria-busy="true"><p role="status">{ui("storefront.loading_page", "Loading page…")}</p></main>}>
            <Routes>
              <Route path="/compare" element={<ComparisonPage />} />
              <Route path="/pages/:key" element={<ContentPage />} />
              <Route
                path="/account/wishlist"
                element={customer ? <AccountFrame><Wishlist customer={customer} /></AccountFrame> : <Navigate to="/login" replace />}
              />
              <Route
                path="/assistant"
                element={
                  <Assistant
                    customer={customer}
                    onAuthenticated={setCustomer}
                  />
                }
              />
              <Route
                path="/support"
                element={
                  <main>
                    <SupportForm
                        customer={customer}
                    />
                  </main>
                }
              />
              <Route
                path="/account/tickets"
                element={customer ? <AccountFrame><CustomerTickets customer={customer} /></AccountFrame> : <Navigate to="/login" replace />}
              />
              <Route
                path="/account/tickets/:id"
                element={customer ? <AccountFrame><CustomerTickets customer={customer} /></AccountFrame> : <Navigate to="/login" replace />}
              />
              <Route path="/" element={<ThemePageView page="home" />} />
              <Route path="/search" element={<ThemePageView page="search"><Browse customer={customer} /></ThemePageView>} />
              <Route path="/cart" element={<ThemePageView page="cart"><CartPage /></ThemePageView>} />
              <Route
                path="/delivery-location"
                element={<DeliveryLocationPage customer={customer} />}
              />
              <Route
                path="/checkout"
                element={<Checkout customer={customer} />}
              />
              <Route
                path="/account/orders"
                element={
                  customer ? <AccountFrame><Orders /></AccountFrame> : <Navigate to="/login" replace />
                }
              />
              <Route
                path="/account/orders/:id"
                element={
                  customer ? <AccountFrame><OrderPage /></AccountFrame> : <Navigate to="/login" replace />
                }
              />
              <Route path="/categories/:id" element={<ThemePageView page="category"><Browse customer={customer} /></ThemePageView>} />
              <Route
                path="/products/:id"
                element={<ThemePageView page="product"><ProductDetail customer={customer} /></ThemePageView>}
              />
              <Route
                path="/login"
                element={<AuthForm key="login" mode="login" />}
              />
              <Route
                path="/register"
                element={<AuthForm key="register" mode="register" />}
              />
              <Route
                path="/verify"
                element={<Challenge key="verify" mode="verify" />}
              />
              <Route
                path="/forgot-password"
                element={<Challenge key="forgot" mode="forgot" />}
              />
              <Route
                path="/reset-password"
                element={<Challenge key="reset" mode="reset" />}
              />
              <Route
                path="/account"
                element={
                  customer ? <AccountFrame><Account /></AccountFrame> : <Navigate to="/login" replace />
                }
              />
              <Route
                path="/account/locations"
                element={
                  customer ? <AccountFrame><Locations /></AccountFrame> : <Navigate to="/login" replace />
                }
              />
              <Route
                path="/account/locations/new"
                element={
                  customer ? <AccountFrame><NewLocation /></AccountFrame> : <Navigate to="/login" replace />
                }
              />
              <Route
                path="/account/addresses"
                element={<Navigate to="/account/locations" replace />}
              />
              <Route
                path="*"
                element={
                  <main>
                    <h1>{ui("storefront.page_not_found", "Page not found")}</h1>
                    <Link to="/">{ui("storefront.return_home", "Return home")}</Link>
                  </main>
                }
              />
            </Routes>
            </Suspense>
          )}
          {!assistantPage && !checkoutPage && <ThemeGlobal location="bottom" footer={<>
            <Link to="/" aria-label={ui("checkout.brand_home", "{brand} home", {brand:heritage?brand:"Rocento"})}>{heritage ? <span className="heritage-wordmark">{brand}</span> : <BrandLogo />}</Link>
            <ManagedContent name="footer" />
            <InstallApp />

          </>} />}
          {!assistantPage && !checkoutPage && <nav className="mobile-bottom-nav" aria-label={ui("storefront.mobile_navigation", "Mobile navigation")} data-assistant={mobileAssistant}>
            <Link to="/search" aria-current={route.pathname === '/search' || route.pathname.startsWith('/categories/') ? 'page' : undefined}><HeaderIcon name="search"/><span>{ui("navigation.shop", "Shop")}</span></Link>
            <Link to={customer ? '/account/wishlist' : '/login'} aria-current={route.pathname === '/account/wishlist' ? 'page' : undefined}><HeaderIcon name="wishlist"/><span>{ui("navigation.wishlist", "Wishlist")}</span></Link>
            {mobileAssistant && <Link to="/assistant"><HeaderIcon name="assistant"/><span>{ui("storefront.assistant", "Assistant")}</span></Link>}
            <span className="mobile-cart" data-active={route.pathname === '/cart'}><CartLink /></span>
            <Link to={customer ? '/account' : '/login'} aria-current={(route.pathname.startsWith('/account') && route.pathname !== '/account/wishlist') || route.pathname === '/login' ? 'page' : undefined}><HeaderIcon name="account"/><span>{ui("storefront.account", "Account")}</span></Link>
          </nav>}
        </div>
      </CartProvider>
    </AuthContext.Provider>
  );
}
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <InterfaceProvider><NotificationProvider><ThemeProvider><ComparisonProvider><App /></ComparisonProvider></ThemeProvider></NotificationProvider></InterfaceProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
