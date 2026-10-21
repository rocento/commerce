import type {CorpusCase} from '../types.ts';
// Compositional regression coverage, not independent natural-language validation.
// Prefix families are split; all remain authored templates, never training records.
export function* structureCases():Generator<CorpusCase> {
 const prefixes=[['','train'],['please ','train'],['i need to ','train'],['i want to ','train'],['could you please ','development'],['help me ','development'],['pls i need ','test'],['would you kindly ','test']] as const;
 const quantities=[['any two',2],['any three',3],['any twelve',12],['any twenty-one',21]] as const;
 const descriptions=['fresh items','organic apples','mangosteens'];
 const commands=[
  {intent:'ADD_TO_CART',actions:['add','put','place','pop'],targets:['in cart','into my basket']},
  {intent:'REMOVE_FROM_CART',actions:['remove','take'],targets:['from my cart','out of my basket']},
  {intent:'ADD_TO_WISHLIST',actions:['add','put','save'],targets:['to my wishlist','in my favorites']},
  {intent:'REMOVE_FROM_WISHLIST',actions:['remove','take'],targets:['from my wishlist','out of my favorites']},
 ];
 for(const command of commands)for(const action of command.actions)for(const target of command.targets)for(const [prefix,split] of prefixes)for(const [quantity,value] of quantities)for(const description of descriptions)yield {
  text:`${prefix}${action} ${quantity} ${description} ${target}`,intent:command.intent,status:'RESOLVED',difficulty:'MEDIUM',split,templateFamily:'request-structure-'+split,source:'compositional-structure-v4',entities:{quantity:value,selection:'ANY_MATCHING',...(description.startsWith('fresh')?{freshness:'fresh'}:{})}
 };
}
