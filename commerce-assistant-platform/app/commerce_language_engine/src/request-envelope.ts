import {languageValue,languagePattern,languageTemplate} from './recognition-rules.ts';
/** Remove only complete, affirmative request framing. The remaining request is
 * parsed normally, including its negation, conditions, references and actions.
 * This does not remove arbitrary reasons, quoted wording or product modifiers.
 */
export function requestEnvelope(message:string):string|undefined {
 if(message.length>4000||languagePattern('request-envelope.requestEnvelope.pattern.1').test(message)||languagePattern('request-envelope.requestEnvelope.pattern.2').test(message))return;
 let text=message.trim().replace(languagePattern('request-envelope.text.pattern.1'),'').trim();
 const original=text;
 if(languagePattern('request-envelope.requestEnvelope.pattern.3').test(text)&&!languagePattern('request-envelope.requestEnvelope.pattern.4').test(text))return;
 text=text.replace(languagePattern('request-envelope.requestEnvelope.pattern.5'),'');
 const front=languagePattern('request-envelope.front.pattern.1').exec(text);
 if(front&&!languagePattern('request-envelope.requestEnvelope.pattern.6').test(front[1]))text=languageTemplate('request-envelope.requestEnvelope.template.1', [front[2], front[1]]);
 text=text.replace(languagePattern('request-envelope.requestEnvelope.pattern.7'),'');
 text=text.replace(languagePattern('request-envelope.requestEnvelope.pattern.8'),'');
 text=text.replace(languagePattern('request-envelope.requestEnvelope.pattern.9'),'');
 // Conditional and negated tails are substantive clauses, including return-policy questions.
 if(!languagePattern('request-envelope.conditionalTail.pattern.1').test(text))
  text=text.replace(languagePattern('request-envelope.requestEnvelope.pattern.10'),'');
 text=text.replace(languagePattern('request-envelope.requestEnvelope.pattern.11'),'');
 return text&&text!==original?text:undefined;
}
