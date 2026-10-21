import {languageValue,languagePattern,languageTemplate} from './recognition-rules.ts';
// Customer-facing questions are separate from machine-readable missing slots.
export function clarificationMessage(missing:string[],collections:string[]=[],states:string[]=[]):string {
 const questions=[...new Set(missing)].map(slot=>{
  switch(slot){
   case 'collection': return collections.length>1?languageTemplate('clarification.questions.template.1', [collections.join(' or ')]):'Which collection do you mean?';
   case 'productReference': return 'Which product or items do you mean?';
   case 'orderReference': return 'Which order do you mean?';
   case 'quantity': return 'How many items would you like? Please specify a positive number.';
   case 'context':
    if(states.some(s=>s.startsWith('ORDER_')))return 'Which order do you mean?';
    if(states.some(s=>s.startsWith('PRODUCT_')))return 'Which product or items do you mean?';
    return 'Could you clarify which item or previous step this request refers to?';
   default:{
    const label=slot.replace(languagePattern('clarification.label.pattern.1'),'$1 $2').replace(languagePattern('clarification.label.pattern.2'),' ').toLowerCase();
    return languageTemplate('clarification.questions.template.2', [label]);
   }
  }
 });
 return [...new Set(questions)].join(' ')||'Could you provide more details about your request?';
}
