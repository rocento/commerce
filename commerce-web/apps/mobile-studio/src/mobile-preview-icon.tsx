export type PreviewPlatform = "iOS" | "Android";
type PreviewIconName = "home" | "categories" | "cart" | "account" | "wishlist" | "location" | "deals" | "assistant" | "notifications";

// Match the mappings in iOS StorefrontView.icon and Android MainActivity.tabIcon.
// iOS paths are browser approximations of SF Symbols; native rendering can vary by OS.
const iosIcons = {
  notifications: <path d="M6 9a6 6 0 0 1 12 0v6l2 3H4l2-3V9M10 21h4"/>,
  assistant: <path d="M6 4h12a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-7l-4 4v-4H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z"/>,
  deals: <><path d="M3 3h8l10 10-8 8L3 11Z"/><circle cx="7" cy="7" r="1"/></>,
  home: <><path d="m3 10 9-7 9 7M5 9v12h5v-7h4v7h5V9" /></>,
  categories: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  cart: <><path d="M2 3h3l2.2 12H20l2-9H5.6"/><circle cx="9" cy="20" r="1.5" fill="currentColor" stroke="none"/><circle cx="19" cy="20" r="1.5" fill="currentColor" stroke="none"/></>,
  account: <><circle cx="12" cy="12" r="10" /><circle cx="12" cy="9" r="3" fill="currentColor" stroke="none" /><path d="M5 19c1-6 13-6 14 0a10 10 0 0 1-14 0Z" fill="currentColor" stroke="none" /></>,
  wishlist: <path d="M12 21 3.5 12.5C-2 7 6 0 12 6c6-6 14 1 8.5 6.5Z" />,
  location: <><path d="M8 16c-3 .5-5 1.4-5 2.5C3 20.4 7 22 12 22s9-1.6 9-3.5c0-1.1-2-2-5-2.5M12 7v12"/><circle cx="12" cy="4" r="2.5"/></>,
};

// Material Icons.Outlined geometry extracted from the app's Compose 1.7.8 dependency
// (Apache-2.0), plus the exact StoreIcons custom strokes from MainActivity.kt.
const androidPaths = {
  notifications: "M12 2a7 7 0 0 0-7 7v6l-2 3v1h18v-1l-2-3V9a7 7 0 0 0-7-7Zm0 2a5 5 0 0 1 5 5v6.6l.9 1.4H6.1l.9-1.4V9a5 5 0 0 1 5-5Zm-2 17a2 2 0 0 0 4 0Z",
  "home": "M12.0 5.69 l5.0 4.5 V18.0 h-2.0 v-6.0 H9.0 v6.0 H7.0 v-7.81 l5.0 -4.5 M12.0 3.0 L2 12.0 h3.0 v8.0 h6.0 v-6.0 h2 v6.0 h6.0 v-8.0 h3.0 L12.0 3.0 Z",
  "cart": "M15.55 13.0 c0.75 0 1.41 -0.41 1.75 -1.03 l3.58 -6.49 c0.37 -0.66 -0.11 -1.48 -0.87 -1.48 L5.21 4.0 l-0.94 -2.0 L1 2 v2 h2 l3.6 7.59 l-1.35 2.44 C4.52 15.37 5.48 17.0 7.0 17.0 h12.0 v-2.0 L7.0 15.0 l1.1 -2.0 h7.45 Z M6.16 6.0 h12.15 l-2.76 5.0 L8.53 11.0 L6.16 6.0 Z M7.0 18.0 c-1.1 0 -1.99 0.9 -1.99 2 S5.9 22.0 7.0 22.0 s2 -0.9 2 -2.0 s-0.9 -2.0 -2.0 -2.0 Z M17.0 18.0 c-1.1 0 -1.99 0.9 -1.99 2 s0.89 2 1.99 2 s2 -0.9 2 -2.0 s-0.9 -2.0 -2.0 -2.0 Z",
  "account": "M12.0 6.0 c1.1 0 2 0.9 2 2 s-0.9 2 -2.0 2 s-2.0 -0.9 -2.0 -2.0 s0.9 -2.0 2 -2.0 m0 10.0 c2.7 0 5.8 1.29 6.0 2 L6.0 18.0 c0.23 -0.72 3.31 -2.0 6.0 -2.0 m0 -12.0 C9.79 4.0 8.0 5.79 8.0 8.0 s1.79 4.0 4.0 4.0 s4.0 -1.79 4.0 -4.0 s-1.79 -4.0 -4.0 -4.0 Z M12.0 14.0 c-2.67 0 -8.0 1.34 -8.0 4.0 v2 h16.0 v-2.0 c0 -2.66 -5.33 -4.0 -8.0 -4.0 Z",
  "wishlist": "M16.5 3.0 c-1.74 0 -3.41 0.81 -4.5 2.09 C10.91 3.81 9.24 3.0 7.5 3.0 C4.42 3.0 2 5.42 2 8.5 c0 3.78 3.4 6.86 8.55 11.54 L12.0 21.35 l1.45 -1.32 C18.6 15.36 22.0 12.28 22.0 8.5 C22.0 5.42 19.58 3.0 16.5 3.0 Z M12.1 18.55 l-0.1 0.1 l-0.1 -0.1 C7.14 14.24 4.0 11.39 4.0 8.5 C4.0 6.5 5.5 5.0 7.5 5.0 c1.54 0 3.04 0.99 3.57 2.36 h1.87 C13.46 5.99 14.96 5.0 16.5 5.0 c2 0 3.5 1.5 3.5 3.5 c0 2.89 -3.14 5.74 -7.9 10.05 Z",
  "location": "M12.0 2 C8.13 2 5.0 5.13 5.0 9.0 c0 5.25 7.0 13.0 7.0 13.0 s7.0 -7.75 7.0 -13.0 c0 -3.87 -3.13 -7.0 -7.0 -7.0 Z M7.0 9.0 c0 -2.76 2.24 -5.0 5.0 -5.0 s5.0 2.24 5.0 5.0 c0 2.88 -2.88 7.19 -5.0 9.88 C9.92 16.21 7.0 11.85 7.0 9.0 Z M12.0 9.0 m-2.5 0 a2.5 2.5 0 1 1 5 0 a2.5 2.5 0 1 1 -5 0"
} as const;
const androidStrokes = {
  assistant: "M4 3H20V17H9L4 21Z M8 8H16 M8 12H13",
  categories: "M3 3H9V9H3Z M15 3H21V9H15Z M3 15H9V21H3Z M15 15H21V21H15Z",
  deals: "M3 3H11L21 13L13 21L3 11Z M7 7L7.01 7",
} as const;

export function MobilePreviewIcon({ name, platform }: { name: PreviewIconName; platform: PreviewPlatform }) {
  const customStroke = platform === "Android" && (name === "categories" || name === "deals" || name === "assistant");
  return <svg className="ms-native-icon" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"
    data-platform={platform} data-icon={name} fill={platform === "Android" && !customStroke ? "currentColor" : "none"}
    stroke={platform === "iOS" || customStroke ? "currentColor" : undefined} strokeWidth={platform === "iOS" || customStroke ? 1.7 : undefined}
    strokeLinecap="round" strokeLinejoin="round">
    {platform === "Android" ? <path d={name === "categories" || name === "deals" || name === "assistant" ? androidStrokes[name] : androidPaths[name]} /> : iosIcons[name]}
  </svg>;
}
