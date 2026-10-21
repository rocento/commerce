import {clarificationMessage} from './clarification.ts';

type MessageInput={status:string;text:string;intent:string|null;missing:string[];collections?:string[];states?:string[];compoundRequest:boolean;requiresConfirmation:boolean};
const actions:Record<string,string>={
 PRODUCT_SEARCH:'find products',PRODUCT_COMPARE:'compare products',PRODUCT_RECOMMEND:'get product recommendations',
 ADD_TO_CART:'add items to your cart',REMOVE_FROM_CART:'remove items from your cart',VIEW_CART:'view your cart',CLEAR_CART:'empty your cart',UPDATE_CART_QUANTITY:'change the quantity in your cart',
 ADD_TO_WISHLIST:'save items to your wishlist',REMOVE_FROM_WISHLIST:'remove items from your wishlist',VIEW_WISHLIST:'view your wishlist',
 CART_MOVE_FROM_WISHLIST:'move items from your wishlist to your cart',CART_MOVE_TO_WISHLIST:'move items from your cart to your wishlist',
 CREATE_ORDER:'place a new order',REORDER:'repeat an order',CANCEL_ORDER:'cancel your order',TRACK_ORDER:'track your order',ORDER_HISTORY:'view your previous orders',
 START_CHECKOUT:'start checkout',CONTINUE_CHECKOUT:'continue checkout',RETURN_ITEM:'return an item',CONTACT_SUPPORT:'contact support',
};
export function responseMessage(input:MessageInput):string {
 if(input.status==='DENIED')return 'Rocento supports this action, but your current access does not allow it. Contact the store for help.';
 if(input.status==='NEEDS_CONTEXT'){
  if(input.missing.length===1&&input.missing[0]==='productReference'&&['CART_MOVE_FROM_WISHLIST','CART_MOVE_TO_WISHLIST'].includes(input.intent??''))return input.intent==='CART_MOVE_FROM_WISHLIST'?'Which wishlist item would you like to move to your cart?':'Which cart item would you like to move to your wishlist?';
  return clarificationMessage(input.missing,input.collections,input.states);
 }
 if(input.status==='AMBIGUOUS')return input.compoundRequest?'I found more than one action. Please send one request at a time.':'I’m not sure which action you mean. Please say what you’d like to do.';
 if(input.status==='UNKNOWN')return input.text.trim()?'I couldn’t understand that request. Try “find apples” or “show my cart”.':'Please enter a request.';
 if(input.status==='RESOLVED'){
  const action=input.intent?actions[input.intent]:undefined;
  let message=action?`Understood—you want to ${action}.`:'Understood. Your request is ready for the next step.';
  if(input.requiresConfirmation)message+=' Please confirm before proceeding.';
  return message;
 }
 return 'Something went wrong. Please try again.';
}
