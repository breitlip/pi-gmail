/**
 * Enforcement test: with allowSend=false the extension must NEVER open an SMTP
 * connection — gmail_send / gmail_reply fall back to the IMAP draft-append
 * path. Also covers the confirmSends matrix (confirm / decline / headless /
 * no-confirmation) and the /gmail-config + /gmail-auth persistence behavior.
 *
 * GMAIL_CONFIG_PATH must be set before index.ts is imported (the config path
 * is fixed at module load), so the module is imported dynamically below.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ImapFlow } from "imapflow";

const tmp = mkdtempSync(join(tmpdir(), "pi-gmail-enforce-"));
const CONFIG = join(tmp, "config.json");
process.env.GMAIL_CONFIG_PATH = CONFIG;
// Credential env overrides must not leak into these tests.
delete process.env.GMAIL_EMAIL;
delete process.env.GMAIL_APP_PASSWORD;

function writeConfig(settings: Record<string, unknown>, creds?: { email: string; appPassword: string }) {
  writeFileSync(
    CONFIG,
    JSON.stringify(
      {
        email: creds?.email ?? "test@example.com",
        appPassword: creds?.appPassword ?? "abcdefghijklmnop",
        settings,
      },
      null,
      2,
    ),
  );
}

function readConfig(): {
  email?: string;
  appPassword?: string;
  accounts?: Record<string, { email?: string; appPassword?: string }>;
  defaultAccount?: string;
  settings?: Record<string, unknown>;
} {
  return JSON.parse(readFileSync(CONFIG, "utf8"));
}

/** Write a multi-account (v2) config file. */
function writeMultiConfig(opts: {
  accounts: Record<string, { email: string; appPassword: string }>;
  defaultAccount?: string;
  settings?: Record<string, unknown>;
}) {
  writeFileSync(
    CONFIG,
    JSON.stringify(
      {
        accounts: opts.accounts,
        ...(opts.defaultAccount ? { defaultAccount: opts.defaultAccount } : {}),
        settings: opts.settings ?? { allowSend: false, confirmSends: true },
      },
      null,
      2,
    ),
  );
}

// Default state: draft-only (safe default).
writeConfig({ allowSend: false, confirmSends: true });

const mod = await import("../index.ts");
const ext = mod.default;
const { __setImapClientFactory, __setSmtpTransportFactory } = mod;

import { createMockPi, getTool, makeCtx, makeFakeImap, makeSmtpSpy } from "./mock-pi.ts";

const { client: fakeImap, calls: imapCalls } = makeFakeImap();
__setImapClientFactory(() => fakeImap as unknown as ImapFlow);

const smtp = makeSmtpSpy();
__setSmtpTransportFactory(smtp.factory);

const { pi, mock } = createMockPi();
ext(pi);

function resultText(res: { content: Array<{ text: string }> }): string {
  return res.content.map((c) => c.text).join("\n");
}

function getCommand(name: string) {
  const command = mock.commands.get(name);
  if (!command) throw new Error(`command not registered: ${name}`);
  return command;
}

function lastAppend() {
  assert.ok(imapCalls.appends.length > 0, "expected a draft append");
  const last = imapCalls.appends[imapCalls.appends.length - 1];
  return { path: last.path, flags: last.flags, mime: last.content.toString("utf8") };
}

// ---------------------------------------------------------------------------
// 1. allowSend=false → drafts, never SMTP
// ---------------------------------------------------------------------------

test("allowSend=false: gmail_send saves a draft and never touches SMTP", async () => {
  const tool = getTool(mock, "gmail_send");
  const { ctx } = makeCtx({ hasUI: true, confirmAnswer: true });
  const res = (await tool.execute(
    "call-1",
    { to: "alice@example.com", subject: "Hello from test", body: "Draft body text", cc: "bob@example.com" },
    undefined,
    undefined,
    ctx,
  )) as { content: Array<{ text: string }>; isError?: boolean };

  assert.equal(res.isError, undefined, `expected success, got: ${resultText(res)}`);
  const text = resultText(res);
  assert.match(text, /NOT SENT/i);
  assert.match(text, /draft/i);
  assert.match(text, /Gmail/i);

  // No SMTP transport was created at all.
  assert.equal(smtp.attempts.length, 0, "SMTP transport must not be created in draft-only mode");
  assert.equal(smtp.sentMails.length, 0);

  // The draft-append path was used instead.
  const draft = lastAppend();
  assert.equal(draft.path, "[Gmail]/Drafts");
  assert.deepEqual(draft.flags, ["\\Draft"]);
  assert.match(draft.mime, /Hello from test/);
  assert.match(draft.mime, /Draft body text/);
  assert.match(draft.mime, /alice@example\.com/);
});

test("allowSend=false: gmail_reply saves a threaded draft and never touches SMTP", async () => {
  const tool = getTool(mock, "gmail_reply");
  const { ctx } = makeCtx({ hasUI: true, confirmAnswer: true });
  const res = (await tool.execute(
    "call-2",
    { id: "1", body: "Reply body text", folder: "inbox" },
    undefined,
    undefined,
    ctx,
  )) as { content: Array<{ text: string }>; isError?: boolean };

  assert.equal(res.isError, undefined, `expected success, got: ${resultText(res)}`);
  const text = resultText(res);
  assert.match(text, /NOT SENT/i);
  assert.match(text, /draft/i);

  assert.equal(smtp.attempts.length, 0, "SMTP transport must not be created in draft-only mode");

  const draft = lastAppend();
  assert.equal(draft.path, "[Gmail]/Drafts");
  // Threading headers must be preserved in the draft.
  assert.match(draft.mime, /In-Reply-To:\s*<orig-123@example\.com>/i);
  assert.match(draft.mime, /References:.*<orig-123@example\.com>/i);
  assert.match(draft.mime, /alice@example\.com/);
  assert.match(draft.mime, /Re: Hello/);
  assert.match(draft.mime, /Reply body text/);
});

// ---------------------------------------------------------------------------
// 2. allowSend=true + confirmSends=true: interactive confirmation
// ---------------------------------------------------------------------------

test("allowSend=true, confirmSends=true, user confirms → real send via SMTP", async () => {
  writeConfig({ allowSend: true, confirmSends: true });
  const tool = getTool(mock, "gmail_send");
  const m = makeCtx({ hasUI: true, confirmAnswer: true });
  const res = (await tool.execute(
    "call-3",
    { to: "alice@example.com", subject: "Real send", body: "Sent body" },
    undefined,
    undefined,
    m.ctx,
  )) as { content: Array<{ text: string }>; isError?: boolean };

  assert.equal(res.isError, undefined, `expected success, got: ${resultText(res)}`);
  const text = resultText(res);
  assert.match(text, /Sent to alice@example\.com/i);
  assert.match(text, /<sent-1@example\.com>/);

  // Confirmation was requested with recipient + subject details.
  assert.equal(m.confirmCalls.length, 1);
  assert.match(m.confirmCalls[0], /alice@example\.com/);
  assert.match(m.confirmCalls[0], /Real send/);

  // Exactly one SMTP transport (endpoint 587 succeeded on first try).
  assert.equal(smtp.attempts.length, 1);
  assert.equal(smtp.attempts[0].host, "smtp.gmail.com");
  assert.equal(smtp.sentMails.length, 1);
  assert.match(String(smtp.sentMails[0].to), /alice@example\.com/);
  // And no draft was appended for this one.
  assert.equal(imapCalls.appends.length, 2, "no additional draft append expected");
});

test("allowSend=true, confirmSends=true, user declines → draft fallback", async () => {
  const tool = getTool(mock, "gmail_send");
  const m = makeCtx({ hasUI: true, confirmAnswer: false });
  const res = (await tool.execute(
    "call-4",
    { to: "alice@example.com", subject: "Declined send", body: "Body" },
    undefined,
    undefined,
    m.ctx,
  )) as { content: Array<{ text: string }>; isError?: boolean };

  assert.equal(res.isError, undefined, `expected success, got: ${resultText(res)}`);
  const text = resultText(res);
  assert.match(text, /NOT SENT/i);
  assert.match(text, /declined/i);
  assert.equal(smtp.attempts.length, 1, "no SMTP attempt after declined confirmation");
  const draft = lastAppend();
  assert.match(draft.mime, /Declined send/);
});

test("allowSend=true, confirmSends=true, headless (no UI) → refused, draft fallback", async () => {
  const tool = getTool(mock, "gmail_send");
  const m = makeCtx({ hasUI: false });
  const res = (await tool.execute(
    "call-5",
    { to: "alice@example.com", subject: "Headless send", body: "Body" },
    undefined,
    undefined,
    m.ctx,
  )) as { content: Array<{ text: string }>; isError?: boolean };

  assert.equal(res.isError, undefined, `expected success, got: ${resultText(res)}`);
  const text = resultText(res);
  assert.match(text, /NOT SENT/i);
  assert.match(text, /headless/i);
  assert.equal(m.confirmCalls.length, 0, "no confirmation dialog in headless mode");
  assert.equal(smtp.attempts.length, 1, "no SMTP attempt in headless mode");
  const draft = lastAppend();
  assert.match(draft.mime, /Headless send/);
});

// ---------------------------------------------------------------------------
// 3. allowSend=true + confirmSends=false → send without confirmation
// ---------------------------------------------------------------------------

test("allowSend=true, confirmSends=false → send without confirmation", async () => {
  writeConfig({ allowSend: true, confirmSends: false });
  const tool = getTool(mock, "gmail_send");
  const m = makeCtx({ hasUI: true });
  const res = (await tool.execute(
    "call-6",
    { to: "alice@example.com", subject: "Unconfirmed send", body: "Body" },
    undefined,
    undefined,
    m.ctx,
  )) as { content: Array<{ text: string }>; isError?: boolean };

  assert.equal(res.isError, undefined, `expected success, got: ${resultText(res)}`);
  assert.match(resultText(res), /Sent to alice@example\.com/i);
  assert.equal(m.confirmCalls.length, 0, "no confirmation when confirmSends=false");
  assert.equal(smtp.attempts.length, 2, "one more SMTP attempt");
});

// ---------------------------------------------------------------------------
// 4. /gmail-config: show + toggle settings, persist at mode 0600
// ---------------------------------------------------------------------------

test("/gmail-config toggles allowSend and persists config at mode 0600", async () => {
  writeConfig({ allowSend: true, confirmSends: false });
  const command = mock.commands.get("gmail-config");
  assert.ok(command, "gmail-config command must be registered");

  const m = makeCtx({ hasUI: true, selectAnswer: "Disable sending (allowSend → false)" });
  await command.handler("", m.ctx);

  const cfg = readConfig();
  assert.equal(cfg.settings?.allowSend, false);
  assert.equal(cfg.settings?.confirmSends, false, "unrelated setting must be preserved");
  // Legacy credentials must survive the write (migrated to the accounts map).
  assert.equal(cfg.accounts?.["test@example.com"]?.email, "test@example.com", "credentials must be preserved");
  assert.equal(statSync(CONFIG).mode & 0o777, 0o600, "config file must stay mode 0600");
  assert.ok(m.notifications.some((n) => /Settings saved/.test(n.message)));
});

test("/gmail-config toggles confirmSends back on", async () => {
  const command = getCommand("gmail-config");
  const m = makeCtx({ hasUI: true, selectAnswer: "Enable send confirmation (confirmSends → true)" });
  await command.handler("", m.ctx);
  const cfg = readConfig();
  assert.equal(cfg.settings?.confirmSends, true);
  assert.equal(cfg.settings?.allowSend, false, "allowSend must be preserved");
});

test("/gmail-config works headless (read-only summary)", async () => {
  const command = getCommand("gmail-config");
  const m = makeCtx({ hasUI: false });
  await command.handler("", m.ctx);
  assert.ok(m.notifications.some((n) => /allowSend: false/.test(n.message)));
  assert.equal(m.selectCalls.length, 0, "no dialog in headless mode");
});

// ---------------------------------------------------------------------------
// 5. /gmail-auth: saves credentials, preserves settings, mode 0600
// ---------------------------------------------------------------------------

test("/gmail-auth adds an account, preserves settings, keeps mode 0600", async () => {
  writeConfig({ allowSend: false, confirmSends: true });
  const command = mock.commands.get("gmail-auth");
  assert.ok(command, "gmail-auth command must be registered");

  const m = makeCtx({
    hasUI: true,
    selectAnswer: "Add a new account",
    inputAnswers: ["work@example.com", "work", "abcd efgh ijkl mnop"],
  });
  await command.handler("", m.ctx);

  const cfg = readConfig();
  assert.equal(cfg.accounts?.work?.email, "work@example.com");
  assert.equal(cfg.accounts?.work?.appPassword, "abcdefghijklmnop", "whitespace must be stripped");
  assert.equal(cfg.settings?.allowSend, false, "existing settings must survive /gmail-auth");
  assert.equal(cfg.settings?.confirmSends, true);
  assert.equal(statSync(CONFIG).mode & 0o777, 0o600);
  assert.ok(m.notifications.some((n) => /configured for work@example\.com/.test(n.message)));
});

// ---------------------------------------------------------------------------
// 6. Backward compatibility: legacy two-key config (no settings) ⇒ safe defaults
// ---------------------------------------------------------------------------

test("legacy two-key config falls back to draft-only defaults", async () => {
  writeFileSync(CONFIG, JSON.stringify({ email: "legacy@example.com", appPassword: "abcdefghijklmnop" }));
  const tool = getTool(mock, "gmail_send");
  const m = makeCtx({ hasUI: true, confirmAnswer: true });
  const res = (await tool.execute(
    "call-7",
    { to: "alice@example.com", subject: "Legacy config", body: "Body" },
    undefined,
    undefined,
    m.ctx,
  )) as { content: Array<{ text: string }>; isError?: boolean };

  assert.equal(res.isError, undefined, `expected success, got: ${resultText(res)}`);
  assert.match(resultText(res), /NOT SENT/i);
  assert.equal(m.confirmCalls.length, 0, "draft-only mode must not ask for confirmation");
  const draft = lastAppend();
  assert.match(draft.mime, /Legacy config/);
});

// ---------------------------------------------------------------------------
// 7. Corrupt config is treated as unconfigured (no crash)
// ---------------------------------------------------------------------------

test("corrupt config file is treated as unconfigured", async () => {
  writeFileSync(CONFIG, "{ not valid json !!!");
  const tool = getTool(mock, "gmail_folders");
  const m = makeCtx();
  const res = (await tool.execute("call-8", {}, undefined, undefined, m.ctx)) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  // No credentials → clear NOT_CONFIGURED error, not a crash.
  assert.equal(res.isError, true);
  assert.match(resultText(res), /not configured/i);
});

// ---------------------------------------------------------------------------
// 8. Multi-account: resolution, account param, legacy migration, default
// ---------------------------------------------------------------------------

const MULTI_ACCOUNTS: Record<string, { email: string; appPassword: string }> = {
  support: { email: "support@example.com", appPassword: "abcdefghijklmnop" },
  pb: { email: "pb@example.com", appPassword: "qrstuvwxyz123456" },
};

type ExecResult = { content: Array<{ text: string }>; isError?: boolean };

test("multi-account: no account param uses the default account", async () => {
  writeMultiConfig({ accounts: MULTI_ACCOUNTS, defaultAccount: "support" });
  const tool = getTool(mock, "gmail_draft");
  const m = makeCtx();
  const res = (await tool.execute(
    "m1",
    { subject: "Default account draft", body: "Body" },
    undefined,
    undefined,
    m.ctx,
  )) as ExecResult;

  assert.equal(res.isError, undefined, resultText(res));
  const draft = lastAppend();
  assert.match(draft.mime, /From:\s*support@example\.com/i);
});

test("multi-account: account param by name selects that account", async () => {
  writeMultiConfig({ accounts: MULTI_ACCOUNTS, defaultAccount: "support" });
  const tool = getTool(mock, "gmail_draft");
  const m = makeCtx();
  const res = (await tool.execute(
    "m2",
    { subject: "Named account draft", body: "Body", account: "pb" },
    undefined,
    undefined,
    m.ctx,
  )) as ExecResult;

  assert.equal(res.isError, undefined, resultText(res));
  const draft = lastAppend();
  assert.match(draft.mime, /From:\s*pb@example\.com/i);
});

test("multi-account: account param by email (case-insensitive) selects that account", async () => {
  writeMultiConfig({ accounts: MULTI_ACCOUNTS, defaultAccount: "support" });
  const tool = getTool(mock, "gmail_draft");
  const m = makeCtx();
  const res = (await tool.execute(
    "m3",
    { subject: "Email account draft", body: "Body", account: "PB@example.com" },
    undefined,
    undefined,
    m.ctx,
  )) as ExecResult;

  assert.equal(res.isError, undefined, resultText(res));
  const draft = lastAppend();
  assert.match(draft.mime, /From:\s*pb@example\.com/i);
});

test("multi-account: account param by local part (before @) selects that account", async () => {
  // Account names differ from the email local parts here, so only the
  // local-part match can resolve "support".
  writeMultiConfig({
    accounts: {
      work: { email: "support@example.com", appPassword: "abcdefghijklmnop" },
      home: { email: "pb@example.com", appPassword: "qrstuvwxyz123456" },
    },
    defaultAccount: "home",
  });
  const tool = getTool(mock, "gmail_draft");
  const m = makeCtx();
  const res = (await tool.execute(
    "m4",
    { subject: "Local part draft", body: "Body", account: "support" },
    undefined,
    undefined,
    m.ctx,
  )) as ExecResult;

  assert.equal(res.isError, undefined, resultText(res));
  const draft = lastAppend();
  assert.match(draft.mime, /From:\s*support@example\.com/i);
});

test("multi-account: unknown account → clear error listing configured accounts", async () => {
  writeMultiConfig({ accounts: MULTI_ACCOUNTS, defaultAccount: "support" });
  const tool = getTool(mock, "gmail_folders");
  const m = makeCtx();
  const res = (await tool.execute("m5", { account: "nope" }, undefined, undefined, m.ctx)) as ExecResult;

  assert.equal(res.isError, true);
  assert.match(resultText(res), /Unknown Gmail account "nope"/);
  assert.match(resultText(res), /support@example\.com/);
  assert.match(resultText(res), /pb@example\.com/);
});

test("multi-account: several accounts, no default, no param → error asking to pick", async () => {
  writeMultiConfig({ accounts: MULTI_ACCOUNTS }); // no defaultAccount
  const tool = getTool(mock, "gmail_folders");
  const m = makeCtx();
  const res = (await tool.execute("m6", {}, undefined, undefined, m.ctx)) as ExecResult;

  assert.equal(res.isError, true);
  assert.match(resultText(res), /no default account is set/i);
  assert.match(resultText(res), /"account" parameter/);
});

test("legacy config migrates to the accounts map when a second account is added", async () => {
  writeConfig({ allowSend: false, confirmSends: true }); // legacy single account
  const command = getCommand("gmail-auth");
  const m = makeCtx({
    hasUI: true,
    selectAnswer: "Add a new account",
    inputAnswers: ["second@example.com", "second", "qrstuvwxyz123456"],
  });
  await command.handler("", m.ctx);

  const cfg = readConfig();
  assert.equal(cfg.accounts?.["test@example.com"]?.email, "test@example.com", "legacy account must be preserved");
  assert.equal(cfg.accounts?.second?.email, "second@example.com");
  assert.equal(cfg.defaultAccount, "test@example.com", "legacy account becomes the default");
  assert.equal(cfg.settings?.allowSend, false, "settings must be preserved");
});

test("/gmail-auth sets the default account", async () => {
  writeMultiConfig({ accounts: MULTI_ACCOUNTS, defaultAccount: "support" });
  const command = getCommand("gmail-auth");
  const m = makeCtx({
    hasUI: true,
    selectAnswers: ["Set default account", "pb — pb@example.com"],
  });
  await command.handler("", m.ctx);

  const cfg = readConfig();
  assert.equal(cfg.defaultAccount, "pb");
  assert.equal(cfg.accounts?.support?.email, "support@example.com", "accounts must be preserved");
});

test("/gmail-status lists all accounts with the default marked", async () => {
  writeMultiConfig({ accounts: MULTI_ACCOUNTS, defaultAccount: "support" });
  const command = getCommand("gmail-status");
  const m = makeCtx({ hasUI: false });
  await command.handler("", m.ctx);

  const all = m.notifications.map((n) => n.message).join("\n");
  assert.match(all, /support — support@example\.com \(default\)/);
  assert.match(all, /pb — pb@example\.com/);
});
