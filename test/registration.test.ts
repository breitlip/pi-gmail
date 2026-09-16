import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import ext from "../index.ts";
import { createMockPi, getTool } from "./mock-pi.ts";

const EXPECTED_TOOLS = [
  "gmail_folders",
  "gmail_list",
  "gmail_read",
  "gmail_send",
  "gmail_reply",
  "gmail_draft",
  "gmail_mark",
  "gmail_move",
  "gmail_save_attachment",
] as const;

const EXPECTED_COMMANDS = ["gmail-auth", "gmail-status", "gmail-config"] as const;

function register() {
  const { pi, mock } = createMockPi();
  ext(pi);
  return mock;
}

test("registers all 9 tools", () => {
  const mock = register();
  assert.deepEqual(mock.tools.map((t) => t.name).sort(), [...EXPECTED_TOOLS].sort());
});

test("registers /gmail-auth, /gmail-status, /gmail-config", () => {
  const mock = register();
  for (const name of EXPECTED_COMMANDS) {
    assert.ok(mock.commands.has(name), `missing command: ${name}`);
    assert.equal(typeof mock.commands.get(name)?.handler, "function");
  }
});

test("subscribes to session_start", () => {
  const mock = register();
  assert.ok((mock.events.get("session_start") ?? []).length >= 1);
});

// Valid + invalid sample params per tool, for typebox schema validation.
// (invalid is optional — gmail_folders takes no params, so any object passes.)
const SAMPLES: Record<string, { valid: Record<string, unknown>; invalid?: Record<string, unknown> }> = {
  gmail_folders: { valid: {} },
  gmail_list: {
    valid: { folder: "inbox", limit: 5, unreadOnly: false, query: "test" },
    invalid: { limit: 0 },
  },
  gmail_read: {
    valid: { id: "123", folder: "inbox", maxChars: 5000 },
    invalid: {},
  },
  gmail_send: {
    valid: { to: "a@b.c", subject: "s", body: "b", cc: ["c@d.e"], bcc: "e@f.g", html: false },
    invalid: {},
  },
  gmail_reply: {
    valid: { id: "1", body: "b", folder: "inbox", to: "a@b.c", html: true },
    invalid: { body: "no id" },
  },
  gmail_draft: {
    valid: { subject: "s", body: "b", to: ["a@b.c"], html: false, replaceDraftId: "9" },
    invalid: { body: "no subject" },
  },
  gmail_mark: {
    valid: { id: "1", flag: "read" },
    invalid: { id: "1", flag: "bogus" },
  },
  gmail_move: {
    valid: { id: "1", to: "trash" },
    invalid: { to: "trash" },
  },
  gmail_save_attachment: {
    valid: { id: "1", filename: "a.txt", destPath: "/tmp/a.txt", folder: "inbox" },
    invalid: { id: "1", destPath: "/tmp/a.txt" },
  },
};

test("every tool has a valid typebox object schema that accepts good params and rejects bad ones", () => {
  const mock = register();
  for (const tool of mock.tools) {
    const schema = tool.parameters as { type: string };
    assert.equal(schema.type, "object", `${tool.name}: parameters must be an object schema`);

    const sample = SAMPLES[tool.name];
    assert.ok(sample, `missing sample for ${tool.name}`);
    assert.ok(
      Value.Check(tool.parameters, sample.valid),
      `${tool.name}: valid sample rejected: ${JSON.stringify(Value.Errors(tool.parameters, sample.valid))}`,
    );
    if (sample.invalid !== undefined) {
      assert.ok(!Value.Check(tool.parameters, sample.invalid), `${tool.name}: invalid sample was accepted`);
    }
  }
});

test("tool descriptions and prompt snippets are non-empty", () => {
  const mock = register();
  for (const tool of mock.tools) {
    assert.ok(tool.description?.trim(), `${tool.name}: missing description`);
    assert.ok(tool.promptSnippet?.trim(), `${tool.name}: missing promptSnippet`);
  }
});

test("draft-only mode (default) is reflected in gmail_send/gmail_reply descriptions", () => {
  const mock = register();
  const send = getTool(mock, "gmail_send");
  const reply = getTool(mock, "gmail_reply");
  assert.match(send.description, /DRAFT-ONLY/i);
  assert.match(send.description, /does NOT send/i);
  assert.match(reply.description, /DRAFT-ONLY/i);
  assert.match(send.promptSnippet ?? "", /draft/i);
});
