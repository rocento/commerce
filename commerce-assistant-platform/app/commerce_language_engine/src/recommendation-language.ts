import {withDictionaryRecognition} from './recognition-rules.ts';
import {languageValue,languagePattern,languageTemplate} from './recognition-rules.ts';
import {canonicalRead} from './read-language.ts';
import type {Dictionary} from './types.ts';
import {orderProductRequest} from './order-product-language.ts';

/** Normalize a complete recommendation question, retaining its entire product/filter tail. */
export function recommendationRequest(dictionary: Dictionary, message: string): string | undefined {
 return withDictionaryRecognition(dictionary,()=>{
 if (canonicalRead(message) || languagePattern('recommendation-language.recommendationRequest.pattern.1').test(message)) return;
 if (message.length > 500 || languagePattern('recommendation-language.recommendationRequest.pattern.2').test(message)) return;
 let text = message.trim().replace(languagePattern('recommendation-language.text.pattern.1'), '').replace(languagePattern('recommendation-language.text.pattern.2'), '');
 // These words introduce additional requirements/actions, not conversational filler.
 if (languagePattern('recommendation-language.recommendationRequest.pattern.3').test(text)) return;
 text = text.replace(languagePattern('recommendation-language.recommendationRequest.pattern.4'), '');
 let tail: string | undefined;
 // A bare desire is discovery, not an instruction to modify the cart.
 // Counted shopping lists and explicit actions retain their existing handlers.
 const desire = languagePattern('recommendation-language.desire.pattern.1').exec(text);
 const directDiscovery = !!desire && !orderProductRequest(text)
  && !languagePattern('recommendation-language.directDiscovery.pattern.1').test(desire[1])
  && !languagePattern('recommendation-language.directDiscovery.pattern.2').test(desire[1])
  && !languagePattern('recommendation-language.directDiscovery.pattern.3').test(desire[1])
  && !languagePattern('recommendation-language.directDiscovery.pattern.4').test(desire[1]);
 if (directDiscovery) tail = desire![1];
 const prefix = languagePattern('recommendation-language.prefix.pattern.1').exec(text);
 const wrappers = [
  languagePattern('recommendation-language.wrappers.pattern.1'),
  languagePattern('recommendation-language.wrappers.pattern.2'),
  languagePattern('recommendation-language.wrappers.pattern.3'),
  languagePattern('recommendation-language.wrappers.pattern.4'),
  languagePattern('recommendation-language.wrappers.pattern.5'),
  languagePattern('recommendation-language.wrappers.pattern.6'),
 ];
 if (prefix) tail = prefix[1];
 for (const pattern of wrappers) { const match = pattern.exec(text); if (match) { tail = match[1]; break; } }
 const suffix = languagePattern('recommendation-language.suffix.pattern.1').exec(text);
 if (suffix) tail = suffix[1] + suffix[2];
 const question = languagePattern('recommendation-language.question.pattern.1').exec(text);
 if (question) tail = question[1] + question[2];
 const purpose = languagePattern('recommendation-language.purpose.pattern.1').exec(text);
 if (purpose) tail = languageValue<string>('recommendation-language.recommendationRequest.value.1') + purpose[1];
 if (!tail || languagePattern('recommendation-language.recommendationRequest.pattern.5').test(tail)) return;
 tail = tail.trim().replace(languagePattern('recommendation-language.recommendationRequest.pattern.6'), '').replace(languagePattern('recommendation-language.recommendationRequest.pattern.7'), languageValue<string>('recommendation-language.recommendationRequest.value.2'));
 // "for dinner" is a purpose only when the language vocabulary identifies it.
 // The merchant schema still independently decides whether that purpose is usable.
 const occasion = languagePattern('recommendation-language.occasion.pattern.1').test(tail) || dictionary.entity_terms.some(term => term.type === 'PURPOSE' && term.alias.toLowerCase() === tail!.toLowerCase());
 if (occasion) tail = languageValue<string>('recommendation-language.recommendationRequest.value.3') + tail;
 const canonical = (directDiscovery && !occasion ? languageValue<string>('recommendation-language.canonical.value.1') : languagePattern('recommendation-language.canonical.pattern.1').test(text) ? languageValue<string>('recommendation-language.canonical.value.2') : languageValue<string>('recommendation-language.canonical.value.3')) + tail;
 return canonical.toLowerCase() === message.trim().replace(languagePattern('recommendation-language.recommendationRequest.pattern.8'), '').toLowerCase() ? undefined : canonical;

 });
}
