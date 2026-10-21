import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { AssistantClarification } from "./assistant-clarification";

const original = { original_message: "I need luxury rings", question: "Which style do you prefer?" };

it("renders catalog choices and an optional skip alongside a free reply", () => {
  const html = renderToStaticMarkup(<AssistantClarification context={{ ...original, kind: "shopping", revision: "00000000-0000-0000-0000-000000000001", choices: ["Classic", "Statement"], optional: true }} onReply={vi.fn()} />);
  expect(html).toContain("Available product preferences");
  expect(html).toContain('type="button">Classic</button>');
  expect(html).toContain('type="button">Statement</button>');
  expect(html).toContain('type="button">Show options</button>');
  expect(html).toContain('maxLength="250"');
});

it("does not offer skipping a required question or choices for action clarification", () => {
  const required = renderToStaticMarkup(<AssistantClarification context={{ ...original, kind: "shopping", revision: "00000000-0000-0000-0000-000000000001", choices: ["Classic"], optional: false }} onReply={vi.fn()} />);
  expect(required).not.toContain(">Show options</button>");
  const legacy = renderToStaticMarkup(<AssistantClarification context={original} onReply={vi.fn()} />);
  expect(legacy).not.toContain("Available product preferences");
  expect(legacy).not.toContain("Start a different request");
});
