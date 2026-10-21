// Authored expectations for the canonical examples under conservative scoring.
// These annotate evaluation data only; the resolver never consults this table.
export function canonicalScoringExpectation(code:string) {
 // Quantity snapshots use the same authoritative cart-total route.
 if(code==='CART_ITEM_COUNT')return {intent:'CART_TOTAL',status:'RESOLVED'};
 const ambiguous=['PRODUCT_ALTERNATIVE','PRODUCT_SIMILAR','PRODUCT_TRENDING','PRODUCT_BESTSELLERS'];
 const weak=['RETURN_ITEM','PRODUCT_NEW_ARRIVALS','REORDER','AFFIRM','DENY','GO_BACK','CONTINUE','REPEAT','CLARIFY','SHOW_MORE','SELECT_FIRST','SELECT_SECOND','SELECT_LAST','SELECT_PRODUCT','REPEAT_PREVIOUS_ACTION'];
 const incomplete=['PRODUCT_MATERIAL','PRODUCT_ORIGIN','PRODUCT_COMPATIBILITY','PRODUCT_USAGE','PRODUCT_CARE','RESTOCK_QUERY','RETURN_ELIGIBILITY','SELECT_ORDER','SELECT_VARIANT','SELECT_DELIVERY_SLOT'];
 if(ambiguous.includes(code))return {intent:null,status:'AMBIGUOUS'};
 if(weak.includes(code))return {intent:null,status:'UNKNOWN'};
 if(incomplete.includes(code))return {intent:code,status:'NEEDS_CONTEXT'};
 return {intent:code,status:'RESOLVED'};
}
