import assert from "node:assert/strict";
import test from "node:test";
import { plainAgentErrorText } from "./agent-error-text.ts";
import type { AgentDetails } from "./ui/agent-widget.ts";

const textContent = (text: string) => [{ type: "text", text }];
// pi replaces a thrown tool error with `{ content, details: {} }`, while a failed run keeps the
// AgentDetails it built.
const rejectedDetails = {} as AgentDetails;
const failedRunDetails = { status: "error" } as unknown as AgentDetails;

test("renders a thrown rejection as plain error text", () => {
  assert.equal(
    plainAgentErrorText(textContent("Agent call rejected: invalid cwd."), rejectedDetails, true),
    "Agent call rejected: invalid cwd.",
  );
  assert.equal(plainAgentErrorText(textContent(""), rejectedDetails, true), "Agent call failed.");
});

test("leaves a failed run to the detailed renderer", () => {
  assert.equal(
    plainAgentErrorText(textContent("Agent failed: process identity lost"), failedRunDetails, true),
    undefined,
  );
});

test("renders no error for successful results", () => {
  assert.equal(plainAgentErrorText(textContent("done"), undefined, false), undefined);
  assert.equal(plainAgentErrorText(textContent("done"), failedRunDetails, undefined), undefined);
});
