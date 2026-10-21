export const site = {
  name: "Rocento",
  description:
    "A connected commerce platform that helps teams run the store, understand customer journeys and introduce AI with clear boundaries.",
  url: process.env.SITE_URL || "http://localhost:5180",
};
export const navigation = [
  ["Platform", "/platform/"],
  ["Features", "/features/"],
  ["Industries", "/industries/"],
  ["Docs", "/docs/"],
  ["Knowledge", "/knowledge/"],
];
export const capabilities = [
  {
    id: "commerce",
    title: "Commerce core",
    symbol: "▧",
    label: "THE FOUNDATION",
    description:
      "The essentials, connected. Catalog, customers, cart, checkout, orders, inventory and promotions.",
    status: "Core capability",
  },
  {
    id: "storefront",
    title: "Composable storefront",
    symbol: "⊞",
    label: "THE EXPERIENCE",
    description:
      "Distinct experiences built from configurable themes, reusable sections and shared commerce capabilities.",
    status: "Core capability",
  },
  {
    id: "behavior",
    title: "Behavioral intelligence",
    symbol: "⌁",
    label: "THE SIGNAL",
    description:
      "Connect search, product interactions, carts and checkout events to understand the customer journey.",
    status: "Event collection",
  },
  {
    id: "analytics",
    title: "Commerce analytics",
    symbol: "▥",
    label: "THE CONTEXT",
    description:
      "Bring revenue, product, customer and inventory reporting into the same conversation.",
    status: "Operational reporting",
  },
  {
    id: "ai",
    title: "AI & machine learning",
    symbol: "✳",
    label: "THE INTELLIGENCE",
    description:
      "An architecture for recommendations, intent, forecasting and prediction. Models are research directions.",
    status: "Research & development",
  },
  {
    id: "agents",
    title: "AI agents",
    symbol: "↗",
    label: "THE ACTION",
    description:
      "Grounded shopping assistance through scoped, read-only application tools. Broader automation is planned.",
    status: "Assistant preview",
  },
];
function demoUrl(value: string | undefined) {
  if (!value) return undefined;
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Demo URLs must use HTTP(S)");
  return url.href;
}
export const demos = [
  {
    id: "pharmacy",
    title: "Pharmacy & Skincare",
    eyebrow: "THE ART OF EVERYDAY CARE",
    description: "Thoughtful care. Everyday essentials. Discover skincare, personal care and pharmacy products by brand and care area.",
    image: "/images/pharmacy-ivory.webp",
    alt: "Ivory and soft blush skincare bottles and cream jar on a warm ivory background",
    url: demoUrl(process.env.NEXT_PUBLIC_PHARMACY_DEMO_URL),
  },
  {
    id: "jewelry",
    title: "Jewelry",
    eyebrow: "A DIFFERENT KIND OF BRILLIANCE",
    description:
      "Considered details. Refined discovery. The same foundation, a different expression.",
    image: "/images/jewelry-ivory.webp",
    alt: "Gold solitaire diamond ring on a softly lit ivory background",
    url: demoUrl(process.env.NEXT_PUBLIC_JEWELRY_DEMO_URL),
  },
  {
    id: "grocery",
    title: "Grocery",
    eyebrow: "EVERYDAY, REIMAGINED",
    description:
      "Fresh discovery. Familiar essentials. A commerce experience built around the everyday.",
    image: "/images/grocery-ivory.webp",
    alt: "Whole and sliced fresh oranges on a softly lit ivory background",
    url: demoUrl(process.env.NEXT_PUBLIC_GROCERY_DEMO_URL),
  },
  {
    id: "electronics",
    title: "Electronics",
    eyebrow: "TECH FOR YOUR EVERYDAY",
    description: "Useful innovation. Everyday connections. Discover tech essentials, compare details and find your next upgrade.",
    image: "/images/electronics-ivory.webp",
    alt: "Terracotta over-ear headphones on a softly lit ivory background",
    url: demoUrl(process.env.NEXT_PUBLIC_ELECTRONICS_DEMO_URL),
  },
];
