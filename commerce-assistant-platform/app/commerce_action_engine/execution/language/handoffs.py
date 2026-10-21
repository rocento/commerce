"""Explicit next steps for understood intents without an in-chat executor.

These are storefront handoffs, not completed commerce actions. Keep intent lists
explicit so a new dictionary intent fails the coverage check until reviewed.
"""

from dataclasses import dataclass
from types import MappingProxyType


@dataclass(frozen=True)
class Handoff:
    path: str
    label: str
    instruction: str

    def message(self) -> str:
        return f"{self.instruction} [{self.label}]({self.path})."


def _handoffs() -> dict[str, Handoff]:
    result: dict[str, Handoff] = {}

    def group(codes: str, path: str, label: str, instruction: str) -> None:
        for code in codes.split():
            if code in result:
                raise ValueError(f"Duplicate handoff: {code}")
            result[code] = Handoff(path, label, instruction)

    group(
        """PRODUCT_ALTERNATIVE PRODUCT_SIMILAR PRODUCT_NEW_ARRIVALS PRODUCT_TRENDING PRODUCT_BESTSELLERS
        PRODUCT_DETAILS PRODUCT_ATTRIBUTE PRODUCT_INGREDIENTS PRODUCT_MATERIAL PRODUCT_DIMENSIONS
        PRODUCT_COMPATIBILITY PRODUCT_USAGE PRODUCT_CARE PRODUCT_ORIGIN PRODUCT_WARRANTY PRODUCT_VARIANTS
        COMPARE_PRICE COMPARE_FEATURES COMPARE_SIZE COMPARE_BRANDS COMPARE_VARIANTS
        CHECK_PRICE PRICE_RANGE CHECK_STOCK CHECK_STORE_STOCK CHECK_VARIANT_STOCK
        PRODUCT_SAFETY PRODUCT_CERTIFICATION PRODUCT_EXPIRY PRODUCT_SHELF_LIFE PRODUCT_STORAGE
        PRODUCT_SERVING_SIZE PRODUCT_NET_WEIGHT PRODUCT_PACK_CONTENTS PRODUCT_ASSEMBLY PRODUCT_INSTALLATION
        PRODUCT_ENERGY_RATING PRODUCT_BATTERY_LIFE PRODUCT_CHARGING PRODUCT_CONNECTIVITY PRODUCT_RESOLUTION
        PRODUCT_STORAGE_CAPACITY PRODUCT_PROCESSOR PRODUCT_OPERATING_SYSTEM PRODUCT_NETWORK_SUPPORT
        PRODUCT_WATER_RESISTANCE PRODUCT_FIT PRODUCT_FABRIC_COMPOSITION PRODUCT_GEMSTONE PRODUCT_METAL_PURITY
        PRODUCT_AUTHENTICITY PRODUCT_MODEL_NUMBER PRODUCT_BARCODE PRODUCT_ACCESSORIES PRODUCT_SPARE_PARTS
        PRODUCT_RIPENESS PRODUCT_HARVEST_DATE FOOTWEAR_WIDTH FRAGRANCE_NOTES SKIN_TYPE_SUITABILITY
        PRESCRIPTION_REQUIREMENT REFURBISHED_GRADE FIRMWARE_VERSION VEHICLE_FITMENT SAFETY_DATA_SHEET
        CASE_PACK_QUANTITY BUNDLE_PRICE UNIT_PRICE""",
        "/search",
        "Browse products",
        "I can't verify this product information in chat yet. Select the product to check its published details; contact support if the information is missing.",
    )
    group(
        """CHECK_PROMOTION PROMOTION_ELIGIBILITY BULK_DISCOUNT STUDENT_DISCOUNT MEMBER_PRICE EMPLOYEE_DISCOUNT
        COUPON_TERMS COUPON_EXPIRY COUPON_COMBINATION SALE_END_DATE CURRENCY_OPTIONS RETURN_POLICY
        STORE_LOCATION NEAREST_STORE STORE_HOURS SERVICE_AREA CHECK_PICKUP FIND_PICKUP_LOCATION PICKUP_TIME
        CREATE_SUPPORT_REQUEST COMPLAINT CONTACT_SUPPORT""",
        "/support",
        "Contact support",
        "The store's support team can confirm the details for this request. No support request has been submitted from this message; use the support form.",
    )
    group(
        "APPLY_COUPON REMOVE_COUPON OPTIMIZE_CART CART_ITEM_REPLACE",
        "/cart",
        "Open your cart",
        "I can't apply this change in chat yet. Review the items and available controls in your cart. Your cart has not been changed.",
    )
    group(
        "CART_MOVE_FROM_WISHLIST",
        "/account/wishlist",
        "Open your wishlist",
        "Choose the saved product and add the required quantity to your cart, then remove it from your wishlist if you want to move it. Neither collection has been changed.",
    )
    group(
        """CHANGE_ADDRESS SELECT_PAYMENT SELECT_DELIVERY_METHOD CHECKOUT_TOTAL CHECKOUT_GIFT_MESSAGE
        TAX_ESTIMATE TAX_INCLUSION PAYMENT_METHODS PAYMENT_CASH_ON_DELIVERY
        DELIVERY_COST DELIVERY_TIME DELIVERY_DATE VIEW_DELIVERY_SLOTS SELECT_DELIVERY_SLOT CHANGE_DELIVERY_SLOT
        SELECT_PICKUP_LOCATION DELIVERY_INSTRUCTIONS""",
        "/checkout",
        "Continue to checkout",
        "Review the available delivery and payment options and the final total at checkout. No checkout selection or order has been changed.",
    )
    group(
        "CHECK_DELIVERY DELIVERY_AREA",
        "/delivery-location",
        "Choose a delivery location",
        "Select the exact location to check delivery availability for this store.",
    )
    group(
        """REFUND_STATUS PAYMENT_STATUS ORDER_SPLIT_QUERY DELIVERY_TRACKING_LINK DELIVERY_CARRIER
        DELIVERY_DELAY DELIVERY_FAILED_ATTEMPT PICKUP_STATUS PICKUP_READY""",
        "/account/orders",
        "Open My orders",
        "Select the relevant order to review its published details. I haven't verified this status in chat; contact support if the details are unavailable.",
    )
    group(
        "ORDER_MISSING ORDER_MISSING_ITEM ORDER_DUPLICATE",
        "/support",
        "Report an order issue",
        "Include the order number and affected items in the support form. No complaint or order change has been submitted yet.",
    )
    group(
        "ACCOUNT_CREATE",
        "/register",
        "Create an account",
        "Complete the registration form to create your account.",
    )
    group(
        "ACCOUNT_PASSWORD_RESET",
        "/forgot-password",
        "Reset your password",
        "Use the password reset form to request a reset.",
    )
    return result


HANDOFFS = MappingProxyType(_handoffs())
CONTEXT_INTENTS = frozenset(
    [
        "AFFIRM",
        "DENY",
        "GO_BACK",
        "CONTINUE",
        "REPEAT",
        "CLARIFY",
        "SHOW_MORE",
        "SELECT_FIRST",
        "SELECT_SECOND",
        "SELECT_LAST",
        "SELECT_PRODUCT",
        "SELECT_ORDER",
        "SELECT_VARIANT",
        "REPEAT_PREVIOUS_ACTION",
    ]
)
