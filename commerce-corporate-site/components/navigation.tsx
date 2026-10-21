"use client";
import { SiteIcon } from "@/components/site-icon";

import { BrandLogo } from "@/components/brand-logo";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { navigation } from "@/lib/site";
export function Navigation() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, []);
  return (
    <header className="header">
      <div className="nav-wrap">
        <Link prefetch={false} href="/" className="wordmark" aria-label="Rocento home">
          <BrandLogo />
        </Link>
        <button
          ref={button}
          className="menu-toggle"
          aria-expanded={open}
          aria-controls="primary-navigation"
          onClick={() => setOpen(!open)}
        >
          {open ? "Close −" : "Menu +"}
        </button>
        <nav
          id="primary-navigation"
          aria-label="Main navigation"
          className={open ? "navigation open" : "navigation"}
        >
          {navigation.map(([label, href]) => (
            <Link prefetch={false}
              key={label}
              href={href}
              aria-current={pathname === href ? "page" : undefined}
              onClick={() => setOpen(false)}
            >
              {label}
            </Link>
          ))}
          <Link prefetch={false}
            className="nav-cta"
            href="/platform/"
            onClick={() => setOpen(false)}
          >
            Explore Rocento <span><SiteIcon /></span>
          </Link>
        </nav>
      </div>
    </header>
  );
}
