import {languageValue,languagePattern,languageTemplate} from './recognition-rules.ts';
/** Explicit nonliteral framing must never become a commerce command. */
export function conversationIntent(text:string):string|undefined {
 // Quoted product names are data, not the speaker's tone or intent.
 const spoken=text.replace(languagePattern('conversation.spoken.pattern.1'),' ').trim();
 if(languagePattern('conversation.conversationIntent.pattern.1').test(spoken)
   || languagePattern('conversation.conversationIntent.pattern.2').test(spoken)
   || languagePattern('conversation.conversationIntent.pattern.3').test(spoken))return 'CONVERSATION_JOKE';
 return undefined;
}
