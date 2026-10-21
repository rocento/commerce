"""Render the implemented workflow as a reproducible PNG using Pillow."""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).with_name("architecture-workflow.png")
img = Image.new("RGB", (1800, 1720), "#f3f6fb")
d = ImageDraw.Draw(img)
FONT = Path("/System/Library/Fonts/Supplemental")


def font(size, bold=False):
    return ImageFont.truetype(
        str(FONT / ("Arial Bold.ttf" if bold else "Arial.ttf")), size
    )


def text(x, y, value, size=27, color="#20304a", bold=False):
    d.multiline_text((x, y), value, font=font(size, bold), fill=color, spacing=10)


def box(
    x,
    y,
    w,
    h,
    title,
    body,
    fill="#ffffff",
    accent="#2357a4",
    title_size=29,
    body_size=25,
):
    d.rounded_rectangle(
        (x, y, x + w, y + h), radius=20, fill=fill, outline="#cbd6e5", width=2
    )
    d.rounded_rectangle((x, y, x + 7, y + h), radius=3, fill=accent)
    text(x + 26, y + 20, title, title_size, accent, True)
    text(x + 26, y + 65, body, body_size)


def arrow(x, y, xx, yy):
    d.line((x, y, xx, yy), fill="#6f83a1", width=4)
    if yy > y:
        d.polygon([(xx, yy), (xx - 9, yy - 15), (xx + 9, yy - 15)], fill="#6f83a1")


text(80, 48, "Commerce assistant", 52, bold=True)
text(
    80,
    112,
    "Implemented workflow & ownership  •  Architecture checkpoint  /  01 October 2026",
    27,
    color="#60718a",
)
box(
    80,
    175,
    1640,
    105,
    "Storefront → authenticated gateway",
    "Customer message, conversation context and delegated commerce capabilities",
    fill="#e8f0fd",
)
arrow(900, 280, 900, 325)
box(
    80,
    325,
    1640,
    160,
    "Application composition + turn lifecycle",
    "Bootstrap  •  admission  •  interpretation validation  •  journey handlers  •  typed SSE responses\nOwns persistence, timeout, cancellation, cleanup and telemetry wiring",
    fill="#e8f0fd",
)
arrow(900, 485, 900, 545)
d.rounded_rectangle((80, 545, 1720, 810), radius=20, fill="#e8eef5")
text(105, 560, "INTERPRET → PLAN → EXECUTE", 22, color="#60718a", bold=True)
box(
    105,
    605,
    385,
    180,
    "Language engine",
    "Node interpretation\nIntent, entities, references\nStandard-contract validation",
    body_size=23,
    title_size=27,
)
box(
    510,
    605,
    385,
    180,
    "Action domains",
    "Catalog, cart, orders\nWishlist, support, delivery\nMeaning + planning rules",
    body_size=23,
    title_size=27,
)
box(
    915,
    605,
    385,
    180,
    "Orchestration",
    "Bounded compound journey\nReceipts and recovery\nExecution behind flags",
    body_size=23,
    title_size=27,
)
box(
    1320,
    605,
    375,
    180,
    "Resolution + RAG",
    "Admitted model reasoning\nProvider-neutral runtime\nInjected approved retrieval",
    body_size=23,
    title_size=27,
)
arrow(900, 810, 900, 855)
box(
    80,
    855,
    1640,
    140,
    "Domain ports → application-supplied adapters",
    "CommerceTools composes capability adapters and owns its instance counter; it performs no HTTP.\nPlannedCommerceTools adds read guards. Catalog runtime tools and memory have separate adapters.",
    body_size=25,
    fill="#e7f5f0",
    accent="#17715a",
)
arrow(900, 995, 900, 1020)
d.rounded_rectangle(
    (80, 1020, 1720, 1370), radius=20, fill="#e7f5f0", outline="#bdddcf", width=2
)
text(106, 1039, "CAPABILITY TRANSPORTS", 23, color="#17715a", bold=True)
for x, y, title, body in [
    (105, 1085, "Cart", "Scoped reads + mutations"),
    (645, 1085, "Orders", "ID, number, history, oldest"),
    (1185, 1085, "Wishlist", "Read, add/remove, transfer"),
    (105, 1210, "Support", "List, detail, explicit creation"),
    (645, 1210, "Delivery + locations", "Availability + saved locations"),
    (1185, 1210, "Shopper catalog", "Facts, search, sales, discounts"),
]:
    box(x, y, 510, 108, title, body, accent="#17715a", title_size=27, body_size=24)
text(
    110,
    1337,
    "Also adapter-owned: cached catalog tools  •  optional memory  •  compound receipts",
    22,
    color="#426659",
)
arrow(900, 1370, 900, 1415)
box(
    80,
    1415,
    1640,
    115,
    "Rust commerce services remain authoritative",
    "Scoped authorization  •  current facts  •  mutations  •  receipts  →  handlers render typed responses",
    fill="#203858",
    accent="#83cbb6",
    body_size=25,
)
# Light text in dark authority box, replacing its body line.
d.rectangle((100, 1475, 1695, 1517), fill="#203858")
text(
    106,
    1480,
    "Scoped authorization  •  current facts  •  mutations  •  receipts  →  handlers render typed responses",
    25,
    "#ffffff",
)
text(80, 1571, "CHECKPOINT FINDING", 22, "#965517", True)
text(
    80,
    1610,
    "Factory calls create new counters. Define a turn-wide operation budget before further behavior changes.",
    26,
    "#69451f",
)
text(
    80,
    1662,
    "Arrows show conceptual workflow, not every call/import. No deployment or live-provider validation in this checkpoint.",
    22,
    "#60718a",
)
img.save(OUT)
print(OUT)
