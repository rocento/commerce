import type {CorpusCase} from '../types.ts';
// Development contrasts for the compositional rules; never used by the resolver.
const positives:[string,string][]=[
 ['I have problem in my delivered order','COMPLAINT'],
 ['there is an issue with the package I received','COMPLAINT'],
 ['I am not happy with my purchase','COMPLAINT'],
 ['the problem with my delivery is not resolved','COMPLAINT'],
 ['the shop billed me twice','PAYMENT_DUPLICATE_CHARGE'],
 ['my account was debited more than once','PAYMENT_DUPLICATE_CHARGE'],
 ['please message me when the jacket is available again','STOCK_ALERT_CREATE'],
 ['when is this available again','RESTOCK_QUERY'],
 ['stop restock alerts','STOCK_ALERT_CANCEL'],
 ['does it contain sesame','PRODUCT_ALLERGENS'],
 ['are there traces of peanuts in it','PRODUCT_ALLERGENS'],
 ['what ingredients are in this','PRODUCT_INGREDIENTS'],
 ['how long will the battery last','PRODUCT_BATTERY_LIFE'],
 ['can i see a size chart','PRODUCT_SIZE_GUIDE'],
 ['is a bulk order cheaper','BULK_DISCOUNT'],
 ['i received the incorrect item','ORDER_WRONG_ITEM'],
 ['when will the refund arrive','REFUND_TIMELINE'],
 ['how soon will my money be returned','REFUND_TIMELINE'],
 ['my refund has not arrived','REFUND_MISSING'],
 ['i was not home when the driver came','DELIVERY_FAILED_ATTEMPT'],
 ['my reward points were not credited','LOYALTY_MISSING_POINTS'],
 ['when do my points expire','LOYALTY_POINTS_EXPIRY'],
 ['try again with delivery','DELIVERY_REATTEMPT'],
 ['i want to speak with a human','CONTACT_SUPPORT'],
 ['please resend the order confirmation','ORDER_CONFIRMATION_RESEND'],
 ['the package arrived damaged','ORDER_DAMAGED'],
 ['is delivery free','DELIVERY_COST'],
 ['recommend something for camping','PRODUCT_RECOMMEND'],
];
const negatives=[
 'I have no problem with my delivered order','the issue with my order was fixed',
 'I have a problem with my homework','what if I have a problem with my order',
 'my battery was charged twice','i was not charged twice','write a poem about being charged twice',
 'do not notify me when this is back in stock','do not report my missing refund',
 'do not show ingredients','never show the size guide','do not check shipping cost',
 'my points were credited','my courier came on time','nuts are tasty',
];
export const conversationalCases:CorpusCase[]=[
 ...positives.map(([text,intent])=>({text,intent,difficulty:'HARD',split:'development' as const,templateFamily:'conversational-positive-v3',source:'authored-conversation-v3'})),
 ...negatives.map(text=>({text,intent:null,status:'UNKNOWN',difficulty:'NEGATIVE_CONFLICT',split:'development' as const,templateFamily:'conversational-negative-v3',source:'authored-conversation-v3'})),
];
