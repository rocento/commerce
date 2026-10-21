import { useState, type FormEvent } from "react";
import type { AssistantInput } from "@commerce/api-client";

export function AssistantClarification({ context, onReply }: {
  context: NonNullable<AssistantInput["clarification"]>;
  onReply: (answer: string) => void;
}) {
  const [answer, setAnswer] = useState("");
  function submit(event: FormEvent) {
    event.preventDefault();
    if (answer.trim()) onReply(answer.trim());
  }
  return <div className="assistant-clarification-wrapper">
    <form className="assistant-clarification" onSubmit={submit} aria-label="Reply to clarification">
      <p className="assistant-clarification-context">Your request: {context.original_message}</p>
      {context.kind === "shopping" && <div className="assistant-clarification-choices" aria-label="Available product preferences">
        {(context.choices ?? []).map(choice => <button key={choice} type="button" onClick={() => onReply(choice)}>{choice}</button>)}
        {context.optional && <button type="button" onClick={() => onReply("Show options")}>Show options</button>}
      </div>}
      <input aria-label={context.question} autoFocus value={answer} onChange={event => setAnswer(event.target.value)} maxLength={250} placeholder="Type your answer…" required />
      <div><button type="submit" disabled={!answer.trim()}>Send reply</button></div>
    </form>
  </div>;
}
