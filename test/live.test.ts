/**
 * Live IMAP tests — skipped unless GMAIL_LIVE=1 is set.
 *
 * Credentials come from the usual sources: GMAIL_EMAIL + GMAIL_APP_PASSWORD,
 * or the config file (GMAIL_CONFIG_PATH, defaulting to the live install path).
 *
 *   GMAIL_LIVE=1 npm run test:live
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const LIVE = process.env.GMAIL_LIVE === "1";
const SKIP_REASON = "set GMAIL_LIVE=1 to run live Gmail tests (requires valid credentials)";

function liveCredentials(): { email: string; appPassword: string } | null {
  const envEmail = process.env.GMAIL_EMAIL?.trim();
  const envPass = process.env.GMAIL_APP_PASSWORD?.trim();
  if (envEmail && envPass) return { email: envEmail, appPassword: envPass.replace(/\s+/g, "") };
  const path =
    process.env.GMAIL_CONFIG_PATH?.trim() || join(homedir(), ".pi", "agent", "extensions", "gmail", "config.json");
  if (existsSync(path)) {
    try {
      const cfg = JSON.parse(readFileSync(path, "utf8")) as { email?: string; appPassword?: string };
      if (cfg.email?.trim() && cfg.appPassword) {
        return { email: cfg.email.trim(), appPassword: cfg.appPassword.replace(/\s+/g, "") };
      }
    } catch {
      // fall through
    }
  }
  return null;
}

test("live: gmail_list returns the inbox", { skip: LIVE ? false : SKIP_REASON }, async () => {
  const mod = await import("../index.ts");
  const { createMockPi, getTool, makeCtx } = await import("./mock-pi.ts");
  const { pi, mock } = createMockPi();
  mod.default(pi);

  const res = (await getTool(mock, "gmail_list").execute(
    "1",
    { folder: "inbox", limit: 3 },
    undefined,
    undefined,
    makeCtx().ctx,
  )) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  assert.equal(res.isError, undefined, res.content.map((c) => c.text).join("\n"));
  assert.match(res.content[0].text, /INBOX/);
});

test("live: create + delete a test draft", { skip: LIVE ? false : SKIP_REASON }, async () => {
  const creds = liveCredentials();
  if (!creds) throw new Error("live test requires credentials (GMAIL_EMAIL/GMAIL_APP_PASSWORD or config file)");

  const mod = await import("../index.ts");
  const { createMockPi, getTool, makeCtx } = await import("./mock-pi.ts");
  const { pi, mock } = createMockPi();
  mod.default(pi);

  const subject = `pi-gmail live test ${Date.now()}`;
  const res = (await getTool(mock, "gmail_draft").execute(
    "1",
    { subject, body: "pi-gmail live test draft — safe to delete" },
    undefined,
    undefined,
    makeCtx().ctx,
  )) as { content: Array<{ text: string }>; isError?: boolean };
  assert.equal(res.isError, undefined, res.content.map((c) => c.text).join("\n"));
  assert.match(res.content[0].text, /Draft saved/);

  // Cleanup: find the draft by subject and delete it.
  const { ImapFlow } = await import("imapflow");
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: creds.email, pass: creds.appPassword },
    logger: false,
    connectionTimeout: 20_000,
  });
  try {
    await client.connect();
    await client.mailboxOpen("[Gmail]/Drafts", { readOnly: false });
    const uids = (await client.search({ text: subject }, { uid: true })) || [];
    assert.ok(uids.length > 0, "created draft should be findable in Drafts");
    for (const uid of uids) {
      await client.messageDelete(String(uid), { uid: true });
    }
  } finally {
    try {
      await client.logout();
    } catch {
      // ignore
    }
  }
});
