import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
const destinations = [
  ["Products", "/catalog/products", "catalog.read"],
  ["Inventory", "/catalog/inventory", "inventory.read"],
  ["Pages & blocks", "/storefront/pages", "cms.read"],
  ["Reviews", "/marketing/reviews", "reviews.read"],
  ["Orders", "/sales/orders", "orders.read"],
  ["Audit log", "/system/audit", "iam.audit.read"],
];
export function AdminShortcuts({ permissions }: { permissions: string[] }) {
  const [open, setOpen] = useState(false),
    nav = useNavigate();
  const allowed = (p: string) =>
    permissions.includes("*") || permissions.includes(p);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (e.key === "Escape") {
        setOpen(false);
        return;
      }
      const target = e.target as HTMLElement;
      if (
        target.isContentEditable ||
        ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)
      )
        return;
      if (e.altKey && /^[1-6]$/.test(e.key)) {
        const d = destinations[Number(e.key) - 1];
        if (permissions.includes("*") || permissions.includes(d[2])) {
          e.preventDefault();
          nav(d[1]);
          setOpen(false);
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [permissions, nav]);
  return (
    <>
      {open && (
        <section
          className="admin-shortcuts"
          role="dialog"
          aria-label="Quick navigation"
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
          }}
        >
          <h2>Quick navigation</h2>
          <p>Alt + number opens a section.</p>
          {destinations.map(
            (d, n) =>
              allowed(d[2]) && (
                <Link key={d[1]} to={d[1]} onClick={() => setOpen(false)}>
                  {n + 1}. {d[0]}
                </Link>
              ),
          )}
          <button autoFocus onClick={() => setOpen(false)}>
            Close navigation
          </button>
        </section>
      )}
    </>
  );
}
