import { useEffect, useRef, type ReactNode } from 'react';
import type { PreviewPlatform } from './mobile-preview-icon';

// A non-modal dialog keeps the builder and the other device usable. Only the
// covered device is inert; keyboard focus is returned to the product on close.
export function PreviewProductSheet({ platform, locale, close, children, footer, headerAction, title, fullScreen = false }: {
  platform: PreviewPlatform; locale: 'en' | 'ar'; close: () => void; children: ReactNode; footer?: ReactNode; headerAction?: ReactNode; title?: string; fullScreen?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const dismiss = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.show();
    dismiss.current?.focus({ preventScroll: true });
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  return <div className="ms-product-sheet-layer">
    <button type="button" className="ms-product-scrim" tabIndex={-1} aria-label={locale === 'ar' ? 'إغلاق' : 'Close'} onClick={close} />
    <dialog ref={dialog} className={`ms-native-sheet${fullScreen ? " ms-full-screen" : ""}`} aria-label={title || (locale === 'ar' ? 'تفاصيل المنتج' : 'Product details')} onCancel={event => { event.preventDefault(); close(); }} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key !== 'Tab') return;
      const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), input, select, [tabindex="0"]')];
      const first = buttons[0], last = buttons.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      {!fullScreen && platform === 'Android' && <div className="ms-sheet-handle" aria-hidden="true" />}
      <header className="ms-sheet-toolbar"><button ref={dismiss} type="button" aria-label={fullScreen ? (locale === "ar" ? "رجوع" : "Back") : (locale === "ar" ? "تم" : "Done")} onClick={close}>{fullScreen ? (locale === 'ar' ? 'رجوع' : 'Back') : (locale === 'ar' ? 'تم' : 'Done')}</button><strong>{title || (locale === 'ar' ? 'المنتج' : 'Product')}</strong>{headerAction || <span aria-hidden="true" />}</header>
      <div className="ms-sheet-content">{children}</div>
      {footer && <footer className="ms-sheet-footer">{footer}</footer>}
    </dialog>
  </div>;
}
