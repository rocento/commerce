import { useInterface } from './interface-locale';
import './checkout-loading.css';

/** Use the checkout grid from the first paint, including on mobile. */
export function CheckoutLoading() {
  const { t: ui } = useInterface();
  return <main className="checkout-flow" aria-busy="true" aria-label={ui("storefront.loading_checkout", "Loading checkout")}>
    <div className="checkout-layout">
      <aside className="checkout-order-summary" aria-hidden="true">
        <div className="checkout-summary-toggle"><span>{ui("checkout.order_summary", "Order summary")}</span><strong>—</strong></div>
        <div className="checkout-summary-content"><div className="checkout-summary-title"><h2>{ui("checkout.order_summary", "Order summary")}</h2></div><div className="checkout-loading-summary" /></div>
      </aside>
      <div className="checkout-information">
        <div className="checkout-brand-row" aria-hidden="true"><div className="checkout-loading-brand" /></div>
        <div className="checkout-heading"><h1>{ui("checkout.title", "Checkout")}</h1></div>
        <CheckoutFieldsLoading />
      </div>
    </div>
  </main>;
}

export function CheckoutFieldsLoading() {
  const { t: ui } = useInterface();
  return <div className="checkout-loading-fields" role="status">
    <span className="sr-only">{ui("storefront.loading_checkout_details", "Loading checkout details…")}</span>
    <div aria-hidden="true" className="checkout-loading-contact" />
    <div aria-hidden="true" className="checkout-loading-address" />
    <div aria-hidden="true" className="checkout-loading-payment" />
  </div>;
}
