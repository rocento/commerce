// Presentation data for the onboarding wizard. The API remains authoritative
// for accepted plan and theme IDs.
export const themes = [
  {
    id: "pharmacy",
    name: "Pharmacy & Skincare",
    description: "Thoughtful care. Everyday essentials.",
    image: "/themes/pharmacy-ivory.webp",
  },
  {
    id: "jewelry",
    name: "Jewelry",
    description: "Considered details. Refined discovery.",
    image: "/themes/jewelry-ivory.webp",
  },
  {
    id: "grocery",
    name: "Grocery",
    description: "Fresh discovery. Familiar essentials.",
    image: "/themes/grocery-ivory.webp",
  },
  {
    id: "electronics",
    name: "Electronics",
    description: "Useful innovation. Everyday connections.",
    image: "/themes/electronics-ivory.webp",
  },
];

export const plans = [
  { id: "LAUNCH", name: "Launch", priceMinor: 7900, maxTenants: 3 },
  { id: "GROWTH", name: "Growth", priceMinor: 14900, maxTenants: 3 },
  { id: "ENTERPRISE", name: "Enterprise", priceMinor: 39900, maxTenants: 1 },
].map((plan) => ({ ...plan, currency: "USD", pricingStatus: "PROPOSED" }));
