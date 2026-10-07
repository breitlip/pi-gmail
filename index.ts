/**
 * Gmail extension for pi — local IMAP/SMTP with app-password auth.
 *
 * Everything runs on this machine; the only remote peers are Google's
 * IMAP/SMTP servers. No third-party cloud is involved.
 *
 * One-time setup:
 *   1. Make sure 2-Step Verification is on for the Google account.
 *   2. Generate an app password: https://myaccount.google.com/apppasswords
 *   3. In pi, run: /gmail-auth
 *      (or set GMAIL_EMAIL + GMAIL_APP_PASSWORD in the environment)
 *
 * Sending is OFF by default (draft-only mode):
 *   - allowSend=false (default): gmail_send / gmail_reply never open an SMTP
 *     connection. They save the composed mail to [Gmail]/Drafts so the user
 *     can review and send it from Gmail.
 *   - allowSend=true + confirmSends=true (default): an interactive
 *     confirmation is requested right before sending; headless runs (no UI)
 *     refuse to send and fall back to drafting.
 *   - allowSend=true + confirmSends=false: sends without confirmation.
 *   Manage with /gmail-config.
 *
 * Tools:
 *   gmail_folders, gmail_list, gmail_read, gmail_send, gmail_reply, gmail_draft,
 *   gmail_mark, gmail_move, gmail_save_attachment
 * Commands:
 *   /gmail-auth, /gmail-status, /gmail-config
 *
 * Multi-account:
 *   Every tool accepts an optional "account" parameter (account name or email
 *   address). Without it, the single configured account is used, or the
 *   defaultAccount when several are configured. Manage with /gmail-auth.
 *
 * Config file (mode 0600, gitignored):
 *   {
 *     "defaultAccount": "support",
 *     "accounts": {
 *       "support": { "email": "…", "appPassword": "…" },
 *       "pb": { "email": "…", "appPassword": "…" }
 *     },
 *     "settings": { "allowSend": false, "confirmSends": true }
 *   }
 * The legacy single-account shape ({ "email", "appPassword", "settings" })
 * keeps working — it is treated as one account (keyed by its email address)
 * and migrated to the multi-account shape on the next write. Missing settings
 * fall back to the safe defaults above.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ImapFlow, type MessageStructureObject } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Config, credentials, settings
// ---------------------------------------------------------------------------

/**
 * Config file location. Overridable via GMAIL_CONFIG_PATH (tests, non-standard
 * installs); defaults to next to this extension.
 */
const CONFIG_PATH =
  process.env.GMAIL_CONFIG_PATH?.trim() || join(homedir(), ".pi", "agent", "extensions", "gmail", "config.json");

interface Credentials {
  email: string;
  appPassword: string;
}

interface Settings {
  /** When false (default), gmail_send/gmail_reply never send — they save drafts. */
  allowSend: boolean;
  /**
   * When true (default) and allowSend is true, ask for interactive
   * confirmation right before sending. Headless runs then fall back to
   * drafting. Set to false to allow unattended sends.
   */
  confirmSends: boolean;
  /**
   * Addresses always appended to Bcc on gmail_send/gmail_reply/gmail_draft.
   * The special value "self" resolves to the sending account's own email
   * address. Default: none.
   */
  bcc?: string[];
}

const DEFAULT_SETTINGS: Settings = { allowSend: false, confirmSends: true };

interface ConfigFile {
  /** Multi-account (current shape). */
  defaultAccount?: string;
  accounts?: Record<string, { email?: string; appPassword?: string }>;
  /** Legacy single-account shape (still readable). */
  email?: string;
  appPassword?: string;
  settings?: Partial<Settings>;
}

/** Config normalized to the multi-account shape (legacy files included). */
interface NormalizedConfig {
  /** Account name → credentials. */
  accounts: Record<string, Credentials>;
  /** Name of the account used when a tool call does not name one. */
  defaultAccount?: string;
  settings: Settings;
}

function readConfigFile(): ConfigFile | null {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as ConfigFile;
    if (typeof raw !== "object" || raw === null) return null;
    return raw;
  } catch {
    return null; // Corrupt config — treat as unconfigured.
  }
}

/**
 * Read the config file and normalize it to the multi-account shape.
 * The legacy single-account shape ({ email, appPassword }) is treated as one
 * account keyed by its email address. Returns null when no usable account
 * exists (missing or corrupt file).
 */
function readNormalized(): NormalizedConfig | null {
  const cfg = readConfigFile();
  if (!cfg) return null;
  const accounts: Record<string, Credentials> = {};
  let legacySingle = false;
  if (cfg.accounts && typeof cfg.accounts === "object") {
    for (const [name, entry] of Object.entries(cfg.accounts)) {
      if (
        entry &&
        typeof entry === "object" &&
        typeof entry.email === "string" &&
        entry.email.trim() &&
        typeof entry.appPassword === "string" &&
        entry.appPassword
      ) {
        accounts[name] = { email: entry.email.trim(), appPassword: entry.appPassword.replace(/\s+/g, "") };
      }
    }
  }
  if (
    Object.keys(accounts).length === 0 &&
    typeof cfg.email === "string" &&
    cfg.email.trim() &&
    typeof cfg.appPassword === "string" &&
    cfg.appPassword
  ) {
    const email = cfg.email.trim();
    accounts[email] = { email, appPassword: cfg.appPassword.replace(/\s+/g, "") };
    legacySingle = true;
  }
  if (Object.keys(accounts).length === 0) return null;
  const names = Object.keys(accounts);
  let defaultAccount: string | undefined;
  if (typeof cfg.defaultAccount === "string" && accounts[cfg.defaultAccount]) {
    defaultAccount = cfg.defaultAccount;
  } else if (legacySingle && names.length === 1) {
    // A legacy single-account config implicitly uses that account.
    defaultAccount = names[0];
  }
  return {
    accounts,
    defaultAccount,
    settings: {
      allowSend: cfg.settings?.allowSend ?? DEFAULT_SETTINGS.allowSend,
      confirmSends: cfg.settings?.confirmSends ?? DEFAULT_SETTINGS.confirmSends,
      bcc: Array.isArray(cfg.settings?.bcc)
        ? cfg.settings.bcc.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim())
        : undefined,
    },
  };
}

function getSettings(): Settings {
  return readNormalized()?.settings ?? DEFAULT_SETTINGS;
}

/** Summaries of the configured accounts (name + email), for commands. */
function listAccountSummaries(): Array<{ name: string; email: string }> {
  return Object.entries(readNormalized()?.accounts ?? {}).map(([name, a]) => ({ name, email: a.email }));
}

function writeConfigFile(next: ConfigFile): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`);
  chmodSync(CONFIG_PATH, 0o600);
}

function writeNormalized(next: NormalizedConfig): void {
  writeConfigFile({
    accounts: next.accounts,
    ...(next.defaultAccount ? { defaultAccount: next.defaultAccount } : {}),
    settings: next.settings,
  });
}

/**
 * Add or update an account, preserving settings and the default account.
 * Returns the account key that was used (the given name, or the email
 * address when no name was given). The first account added becomes the
 * default.
 */
function saveAccount(name: string | undefined, email: string, appPassword: string): string {
  const norm = readNormalized() ?? { accounts: {}, defaultAccount: undefined, settings: DEFAULT_SETTINGS };
  const key = name?.trim() || email.trim();
  norm.accounts[key] = { email: email.trim(), appPassword: appPassword.replace(/\s+/g, "") };
  if (!norm.defaultAccount) norm.defaultAccount = key;
  writeNormalized(norm);
  return key;
}

/** Set the default account (used when a tool call does not name one). */
function setDefaultAccount(name: string): void {
  const norm = readNormalized();
  if (!norm || !norm.accounts[name]) {
    const list = Object.keys(norm?.accounts ?? {}).join(", ") || "(none)";
    throw new Error(`Unknown account "${name}". Configured accounts: ${list}`);
  }
  norm.defaultAccount = name;
  writeNormalized(norm);
}

/** Save settings, preserving all accounts in the file. */
function saveSettings(settings: Settings): void {
  const norm = readNormalized();
  if (norm) {
    norm.settings = settings;
    writeNormalized(norm);
  } else {
    writeConfigFile({ settings });
  }
}

const NOT_CONFIGURED =
  "Gmail is not configured. Run /gmail-auth in pi, or set GMAIL_EMAIL and GMAIL_APP_PASSWORD. " +
  "App passwords: https://myaccount.google.com/apppasswords (requires 2-Step Verification).";

function accountListText(accounts: Record<string, Credentials>): string {
  return Object.entries(accounts)
    .map(([name, a]) => (name === a.email ? name : `${name} (${a.email})`))
    .join(", ");
}

/**
 * Resolve the account for a tool call:
 *  - explicit `account` param → must match a configured account (name, full
 *    email, or local part before the @), case-insensitive
 *  - no param + GMAIL_EMAIL/GMAIL_APP_PASSWORD env → env credentials
 *    (legacy single-account behavior, env wins)
 *  - no param + one configured account → that account
 *  - no param + several accounts → defaultAccount, or an error asking to pick
 */
function resolveAccount(requested?: string): Credentials {
  const wanted = requested?.trim();
  if (wanted) {
    const norm = readNormalized();
    if (!norm) throw new Error(NOT_CONFIGURED);
    const lower = wanted.toLowerCase();
    let name = Object.keys(norm.accounts).find((k) => k.toLowerCase() === lower);
    if (!name) name = Object.keys(norm.accounts).find((k) => norm.accounts[k].email.toLowerCase() === lower);
    if (!name) {
      const local = lower.split("@")[0];
      if (local) {
        name = Object.keys(norm.accounts).find((k) => norm.accounts[k].email.split("@")[0].toLowerCase() === local);
      }
    }
    if (!name) {
      throw new Error(
        `Unknown Gmail account "${wanted}". Configured accounts: ${accountListText(norm.accounts)}. Add one with /gmail-auth.`,
      );
    }
    return norm.accounts[name];
  }
  const envEmail = process.env.GMAIL_EMAIL?.trim();
  const envPass = process.env.GMAIL_APP_PASSWORD?.trim();
  if (envEmail && envPass) {
    return { email: envEmail, appPassword: envPass.replace(/\s+/g, "") };
  }
  const norm = readNormalized();
  if (!norm) throw new Error(NOT_CONFIGURED);
  const names = Object.keys(norm.accounts);
  if (names.length === 1) return norm.accounts[names[0]];
  if (norm.defaultAccount && norm.accounts[norm.defaultAccount]) return norm.accounts[norm.defaultAccount];
  throw new Error(
    `Multiple Gmail accounts are configured (${accountListText(norm.accounts)}) and no default account is set. ` +
      'Pass the "account" parameter (name or email) to the Gmail tool, or set a default with /gmail-auth.',
  );
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

const FOLDER_ALIASES: Record<string, string> = {
  inbox: "INBOX",
  sent: "[Gmail]/Sent Mail",
  "sent mail": "[Gmail]/Sent Mail",
  starred: "[Gmail]/Starred",
  drafts: "[Gmail]/Drafts",
  spam: "[Gmail]/Spam",
  trash: "[Gmail]/Trash",
  important: "[Gmail]/Important",
  all: "[Gmail]/All Mail",
  "all mail": "[Gmail]/All Mail",
};

export function resolveFolder(folder?: string): string {
  if (!folder) return "INBOX";
  const key = folder.trim().toLowerCase();
  return FOLDER_ALIASES[key] ?? folder.trim();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Address {
  name?: string;
  address?: string;
}

export function formatAddress(addr?: Address): string {
  if (!addr?.address) return "unknown";
  return addr.name ? `${addr.name} <${addr.address}>` : addr.address;
}

export function formatAddresses(addrs?: Address[]): string {
  if (!addrs?.length) return "";
  return addrs.map((a) => formatAddress(a)).join(", ");
}

/**
 * Normalize a mailparser address field to Address[].
 * mailparser v3 returns { value: [{name, address}], html, text } for
 * from/to/cc and address headers; plain strings/arrays are tolerated too.
 */
export function toAddressList(value: unknown): Address[] | undefined {
  if (!value) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [{ address: trimmed }] : undefined;
  }
  if (Array.isArray(value)) {
    const addrs: Address[] = [];
    for (const item of value) {
      const sub = toAddressList(item);
      if (sub) addrs.push(...sub);
    }
    return addrs.length ? addrs : undefined;
  }
  if (typeof value === "object") {
    const obj = value as { value?: unknown; address?: unknown; name?: unknown };
    if (Array.isArray(obj.value)) {
      const addrs: Address[] = [];
      for (const item of obj.value) {
        const sub = toAddressList(item);
        if (sub) addrs.push(...sub);
      }
      return addrs.length ? addrs : undefined;
    }
    if (typeof obj.address === "string" && obj.address) {
      return [{ name: typeof obj.name === "string" ? obj.name : undefined, address: obj.address }];
    }
  }
  return undefined;
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n… [truncated at ${maxChars} chars]`;
}

export function toTextList(value: string | string[] | undefined): string[] | undefined {
  if (!value) return undefined;
  const list = (Array.isArray(value) ? value : [value]).map((s) => s.trim()).filter(Boolean);
  return list.length ? list : undefined;
}

// ---------------------------------------------------------------------------
// Transport factories (with test seams)
// ---------------------------------------------------------------------------

/** Minimal SMTP transport surface used by this extension. */
interface SmtpTransport {
  sendMail(mail: Record<string, unknown>): Promise<{ messageId: string }>;
  close(): void | Promise<void>;
}

type ImapClientFactory = (creds: Credentials) => ImapFlow;
type SmtpTransportFactory = (opts: Record<string, unknown>) => SmtpTransport;

const defaultImapClientFactory: ImapClientFactory = (creds) =>
  new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: creds.email, pass: creds.appPassword },
    logger: false,
    connectionTimeout: 20_000,
  });

const defaultSmtpTransportFactory: SmtpTransportFactory = (opts) =>
  nodemailer.createTransport(opts as never) as unknown as SmtpTransport;

let imapClientFactory: ImapClientFactory = defaultImapClientFactory;
let smtpTransportFactory: SmtpTransportFactory = defaultSmtpTransportFactory;

/** Test seam — replace the IMAP client factory (pass null to restore the default). */
export function __setImapClientFactory(factory: ImapClientFactory | null): void {
  imapClientFactory = factory ?? defaultImapClientFactory;
}

/** Test seam — replace the SMTP transport factory (pass null to restore the default). */
export function __setSmtpTransportFactory(factory: SmtpTransportFactory | null): void {
  smtpTransportFactory = factory ?? defaultSmtpTransportFactory;
}

// ---------------------------------------------------------------------------
// IMAP operations
// ---------------------------------------------------------------------------

async function withImap<T>(fn: (client: ImapFlow) => Promise<T>, account?: string): Promise<T> {
  const creds = resolveAccount(account);
  const client = imapClientFactory(creds);
  try {
    await client.connect();
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch {
      // Connection may already be closed.
    }
  }
}

interface EmailSummary {
  uid: string;
  from: string;
  subject: string;
  date: string;
  unread: boolean;
  starred: boolean;
}

async function listEmails(opts: {
  folder?: string;
  limit: number;
  unreadOnly: boolean;
  query?: string;
  account?: string;
}): Promise<{ mailbox: string; count: number; emails: EmailSummary[] }> {
  return withImap(async (client) => {
    const mailbox = resolveFolder(opts.folder);
    await client.mailboxOpen(mailbox, { readOnly: true });

    // search() resolves to number[] | false | undefined — `|| []` handles all of them.
    let uids: number[] = opts.query
      ? (await client.search({ text: opts.query }, { uid: true })) || []
      : (await client.search({}, { uid: true })) || [];
    if (opts.unreadOnly) {
      const unseen = new Set((await client.search({ seen: false }, { uid: true })) || []);
      uids = uids.filter((u) => unseen.has(u));
    }
    if (uids.length === 0) return { mailbox, count: 0, emails: [] };

    const picked = uids.slice(-opts.limit);
    const emails: EmailSummary[] = [];
    // Note: the third argument { uid: true } is required — search() returned UIDs,
    // and fetch() interprets ranges as sequence numbers by default.
    for await (const msg of client.fetch(picked.join(","), { envelope: true, flags: true, uid: true }, { uid: true })) {
      const env = msg.envelope;
      const flags = msg.flags ?? new Set<string>();
      emails.push({
        uid: String(msg.uid),
        from: formatAddress(env?.from?.[0]),
        subject: env?.subject ?? "(no subject)",
        date: env?.date ? new Date(env.date as Date | string).toISOString() : "unknown",
        unread: !flags.has("\\Seen"),
        starred: flags.has("\\Flagged"),
      });
    }
    emails.reverse(); // fetch returns oldest first; show newest first
    return { mailbox, count: emails.length, emails };
  }, opts.account);
}

interface EmailDetail {
  uid: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  messageId: string;
  unread: boolean;
  attachments: { filename: string; size: number; contentType: string }[];
  body: string;
}

async function readEmail(
  folder: string | undefined,
  uid: string,
  maxChars: number,
  account?: string,
): Promise<EmailDetail> {
  return withImap(async (client) => {
    const mailbox = resolveFolder(folder);
    await client.mailboxOpen(mailbox, { readOnly: true });
    const msg = await client.fetchOne(uid, { envelope: true, flags: true, source: true }, { uid: true });
    // fetchOne resolves to `false | FetchMessageObject | undefined` — check both.
    if (!msg || !msg.source) throw new Error(`Message uid ${uid} not found in ${mailbox}`);

    const parsed = await simpleParser(msg.source, { skipHtmlToText: true });
    const flags = msg.flags ?? new Set<string>();
    const body = (parsed.text || parsed.html || "(empty body)").trim();

    return {
      uid: String(msg.uid),
      from: formatAddress(toAddressList(parsed.from)?.[0]),
      to: formatAddresses(toAddressList(parsed.to)),
      cc: formatAddresses(toAddressList(parsed.cc)),
      subject: parsed.subject ?? "(no subject)",
      date: parsed.date ? new Date(parsed.date).toISOString() : "unknown",
      messageId: parsed.messageId ?? "",
      unread: !flags.has("\\Seen"),
      attachments: (parsed.attachments ?? []).map((a) => ({
        filename: a.filename ?? "(unnamed)",
        size: a.size ?? 0,
        contentType: a.contentType,
      })),
      body: truncate(body, maxChars),
    };
  }, account);
}

async function markEmail(
  folder: string | undefined,
  uid: string,
  flag: "read" | "unread" | "starred" | "unstarred",
  account?: string,
): Promise<string> {
  await withImap(async (client) => {
    const mailbox = resolveFolder(folder);
    await client.mailboxOpen(mailbox, { readOnly: false });
    const imapFlag = flag === "read" || flag === "unread" ? "\\Seen" : "\\Flagged";
    if (flag === "read" || flag === "starred") {
      await client.messageFlagsAdd(uid, [imapFlag], { uid: true });
    } else {
      await client.messageFlagsRemove(uid, [imapFlag], { uid: true });
    }
  }, account);
  return `Marked message ${uid} as ${flag}`;
}

async function moveEmail(folder: string | undefined, uid: string, to: string, account?: string): Promise<string> {
  const dest = resolveFolder(to);
  await withImap(async (client) => {
    const mailbox = resolveFolder(folder);
    await client.mailboxOpen(mailbox, { readOnly: false });
    await client.messageMove(uid, dest, { uid: true });
  }, account);
  return `Moved message ${uid} to ${dest}`;
}

async function listFolders(account?: string): Promise<{ name: string; messages: number; unread: number }[]> {
  return withImap(async (client) => {
    const list = await client.list({ statusQuery: { messages: true, unseen: true } });
    return list.map((m) => ({
      name: m.path,
      messages: m.status?.messages ?? 0,
      unread: m.status?.unseen ?? 0,
    }));
  }, account);
}

export function findAttachmentPart(
  node: MessageStructureObject,
  filename: string,
): { key: string; contentType: string } | null {
  if (node.childNodes?.length) {
    for (const child of node.childNodes) {
      const found = findAttachmentPart(child, filename);
      if (found) return found;
    }
    return null;
  }
  const name = node.dispositionParameters?.filename ?? node.disposition?.match(/filename="?([^"]+)"?/i)?.[1];
  if (name && name.toLowerCase() === filename.toLowerCase()) {
    return { key: node.part ?? "", contentType: node.type };
  }
  return null;
}

async function saveAttachment(opts: {
  folder?: string;
  uid: string;
  filename: string;
  destPath: string;
  account?: string;
}): Promise<{ path: string; size: number; contentType: string }> {
  const MAX_BYTES = 100 * 1024 * 1024;
  return withImap(async (client) => {
    const mailbox = resolveFolder(opts.folder);
    await client.mailboxOpen(mailbox, { readOnly: true });

    const msg = await client.fetchOne(opts.uid, { bodyStructure: true }, { uid: true });
    if (!msg || !msg.bodyStructure) throw new Error(`Message uid ${opts.uid} not found in ${mailbox}`);

    const part = findAttachmentPart(msg.bodyStructure, opts.filename);
    if (!part?.key) throw new Error(`Attachment "${opts.filename}" not found in message ${opts.uid}`);

    const result = await client.downloadMany(opts.uid, [part.key], { uid: true, maxBytes: MAX_BYTES });
    const downloaded = result[part.key];
    if (!downloaded?.content) throw new Error(`Failed to download attachment "${opts.filename}"`);

    mkdirSync(dirname(opts.destPath), { recursive: true });
    writeFileSync(opts.destPath, downloaded.content);
    return {
      path: opts.destPath,
      size: downloaded.content.length,
      contentType: downloaded.meta?.contentType ?? part.contentType,
    };
  }, opts.account);
}

// ---------------------------------------------------------------------------
// SMTP operations
// ---------------------------------------------------------------------------

interface SendOptions {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
}

/**
 * Merge the configured default Bcc (settings.bcc) with the per-call Bcc.
 * "self" resolves to the sending account's email address. Duplicates are
 * removed case-insensitively; explicit per-call addresses keep their order.
 */
export function resolveBcc(senderEmail: string, explicit?: string[]): string[] | undefined {
  const configured = getSettings().bcc ?? [];
  const merged: string[] = [...(explicit ?? [])];
  for (const entry of configured) {
    const addr = entry === "self" ? senderEmail : entry;
    if (!merged.some((a) => a.toLowerCase() === addr.toLowerCase())) merged.push(addr);
  }
  return merged.length ? merged : undefined;
}

// Some networks block implicit-TLS 465 but allow STARTTLS 587 (or vice versa),
// so try both with short explicit timeouts instead of hanging on the default 2 min.
const SMTP_ENDPOINTS: Array<{ host: string; port: number; secure: boolean }> = [
  { host: "smtp.gmail.com", port: 587, secure: false }, // STARTTLS
  { host: "smtp.gmail.com", port: 465, secure: true }, // implicit TLS
];

async function sendMail(opts: SendOptions, account?: string): Promise<string> {
  const creds = resolveAccount(account);
  const bcc = resolveBcc(creds.email, opts.bcc);
  const mail: Record<string, unknown> = {
    from: creds.email,
    to: opts.to.join(","),
    cc: opts.cc?.join(","),
    bcc: bcc?.join(","),
    subject: opts.subject,
    text: opts.text,
    html: opts.html,
    inReplyTo: opts.inReplyTo,
    references: opts.references,
  };

  let lastError: unknown = null;
  for (const endpoint of SMTP_ENDPOINTS) {
    const transporter = smtpTransportFactory({
      host: endpoint.host,
      port: endpoint.port,
      secure: endpoint.secure,
      auth: { user: creds.email, pass: creds.appPassword },
      connectionTimeout: 15_000,
      socketTimeout: 60_000,
      logger: false,
    });
    try {
      const info = await transporter.sendMail(mail);
      return info.messageId;
    } catch (error) {
      lastError = error;
    } finally {
      try {
        await transporter.close();
      } catch {
        // ignore
      }
    }
  }
  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`SMTP send failed on all endpoints (587 STARTTLS, 465 TLS): ${msg}`);
}

// ---------------------------------------------------------------------------
// Reply
// ---------------------------------------------------------------------------

interface ReplyComputation {
  to: string[];
  subject: string;
  inReplyTo?: string;
  references?: string[];
}

/** Fetch the original message and derive the reply recipients/subject/headers. */
async function prepareReply(
  folder: string | undefined,
  uid: string,
  toOverride?: string,
  account?: string,
): Promise<ReplyComputation> {
  const original = await withImap(async (client) => {
    const mailbox = resolveFolder(folder);
    await client.mailboxOpen(mailbox, { readOnly: true });
    const msg = await client.fetchOne(uid, { source: true }, { uid: true });
    if (!msg || !msg.source) throw new Error(`Message uid ${uid} not found in ${mailbox}`);
    return simpleParser(msg.source, { skipHtmlToText: true });
  }, account);

  const replyTo = (toAddressList(original.headers?.get("reply-to")) ?? []).map((a) => a.address ?? "").filter(Boolean);
  const fromAddress = toAddressList(original.from)?.[0]?.address ?? "";
  const to = toOverride ? [toOverride.trim()] : replyTo.length ? replyTo : [fromAddress].filter(Boolean);
  if (!to.length) throw new Error("Could not determine reply recipient (no Reply-To or From header)");

  const subject = /^re:/i.test(original.subject ?? "") ? (original.subject as string) : `Re: ${original.subject ?? ""}`;

  // mailparser may report a single reference as a plain string.
  const refs = typeof original.references === "string" ? [original.references] : (original.references ?? []);

  return {
    to,
    subject,
    inReplyTo: original.messageId,
    references: original.messageId ? [...refs, original.messageId] : undefined,
  };
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

const DRAFTS_FOLDER = "[Gmail]/Drafts";

interface DraftOptions {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  replaceDraftId?: string;
}

/** Build the raw MIME message without any network access (stream transport). */
async function buildRawMail(creds: Credentials, opts: Omit<DraftOptions, "replaceDraftId">): Promise<Buffer> {
  const transporter = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const bcc = resolveBcc(creds.email, opts.bcc);
  const { message } = await transporter.sendMail({
    from: creds.email,
    to: opts.to?.join(","),
    cc: opts.cc?.join(","),
    bcc: bcc?.join(","),
    subject: opts.subject,
    text: opts.text,
    html: opts.html,
    inReplyTo: opts.inReplyTo,
    references: opts.references,
  });
  if (Buffer.isBuffer(message)) return message;
  if (typeof message === "string") return Buffer.from(message, "utf8");
  throw new Error("Unexpected MIME build result (expected a Buffer with buffer:true)");
}

async function createDraft(opts: DraftOptions, account?: string): Promise<{ mailbox: string; size: number }> {
  const creds = resolveAccount(account);
  const raw = await buildRawMail(creds, opts);

  return withImap(async (client) => {
    if (opts.replaceDraftId) {
      await client.mailboxOpen(DRAFTS_FOLDER, { readOnly: false });
      await client.messageDelete(opts.replaceDraftId, { uid: true });
      await client.mailboxClose();
    }
    const res = await client.append(DRAFTS_FOLDER, raw, ["\\Draft"]);
    if (res === false) throw new Error("Gmail rejected the draft append");
    return { mailbox: res.destination, size: raw.length };
  }, account);
}

// ---------------------------------------------------------------------------
// Send guard (draft-only by default)
// ---------------------------------------------------------------------------

interface SendPermission {
  send: boolean;
  /** Human-readable reason for the draft fallback (only when send is false). */
  reason: string | null;
}

/**
 * Decide whether a send may proceed, per the current settings:
 *  - allowSend=false  → draft (never send)
 *  - confirmSends=true + no UI (headless) → refuse, draft
 *  - confirmSends=true + UI → interactive confirmation; decline → draft
 *  - confirmSends=false → send
 */
async function resolveSendPermission(
  ctx: ExtensionContext | undefined,
  detail: { to: string; subject: string },
): Promise<SendPermission> {
  const settings = getSettings();
  if (!settings.allowSend) {
    return { send: false, reason: "sending is disabled (allowSend=false — draft-only mode)" };
  }
  if (!settings.confirmSends) {
    return { send: true, reason: null };
  }
  if (!ctx?.hasUI) {
    return {
      send: false,
      reason: "confirmSends is enabled but no interactive UI is available (headless), so sending is refused",
    };
  }
  const confirmed = await ctx.ui.confirm(
    "Send email from Gmail?",
    `To: ${detail.to}\nSubject: ${detail.subject}\n\nThis will send the email immediately. Continue?`,
  );
  if (!confirmed) {
    return { send: false, reason: "you declined the send confirmation" };
  }
  return { send: true, reason: null };
}

function draftFallbackText(reason: string, mailbox: string, size: number, extra: string): string {
  return (
    `NOT SENT — ${reason}. ${extra} ` +
    `The email was saved as a draft in ${mailbox} (${size} bytes). ` +
    `Review it and send it yourself from Gmail (Drafts folder).`
  );
}

// ---------------------------------------------------------------------------
// Tool result helpers
// ---------------------------------------------------------------------------

type ToolResult = AgentToolResult<unknown> & { isError?: boolean };

function textResult(text: string, details?: unknown): ToolResult {
  return { content: [{ type: "text" as const, text }], details };
}

function errorResult(error: unknown): ToolResult {
  const err = error as (Error & { responseText?: string; executedCommand?: string }) | null;
  let msg = err?.message ?? String(error);
  if (err?.responseText) msg += ` — server said: ${err.responseText}`;
  if (err?.executedCommand) msg += ` — command: ${err.executedCommand}`;
  return { content: [{ type: "text" as const, text: `Gmail error: ${msg}` }], details: undefined, isError: true };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const folderParam = Type.Optional(
  Type.String({
    description:
      'Folder: inbox, sent, starred, drafts, spam, trash, important, all — or an exact label/folder name (default: "inbox")',
  }),
);

const accountParam = Type.Optional(
  Type.String({
    description:
      "Gmail account to use: account name or email address (e.g. 'support' or 'support@plaincode.com'). " +
      "Only needed when multiple accounts are configured — otherwise the single/default account is used.",
  }),
);

export default function (pi: ExtensionAPI) {
  // Descriptions reflect the active send mode at registration time; the tool
  // result text always states what actually happened.
  const settings = getSettings();
  const multiAccountNote =
    " If several Gmail accounts are configured, select one with the account parameter (name or email).";
  const sendDescription = (kind: "new email" | "reply"): string => {
    if (!settings.allowSend) {
      return `Compose a ${kind} from a configured Gmail account. DRAFT-ONLY MODE (allowSend=false): this tool does NOT send — it saves the ${kind} to [Gmail]/Drafts for the user to review and send from Gmail.${multiAccountNote}`;
    }
    const confirm = settings.confirmSends
      ? " An interactive confirmation is requested right before sending; without an interactive UI (headless) the mail is saved as a draft instead."
      : " No confirmation is requested.";
    return `Send a ${kind} from a configured Gmail account (allowSend=true).${confirm}${multiAccountNote}`;
  };
  const sendSnippet = (kind: "new email" | "reply"): string =>
    settings.allowSend
      ? `Send a Gmail ${kind} (asks for confirmation)`
      : `Compose a Gmail ${kind} (draft-only: saved to Drafts, NOT sent)`;

  // ---- gmail_folders -------------------------------------------------------
  pi.registerTool({
    name: "gmail_folders",
    label: "Gmail Folders",
    description: "List Gmail folders/labels with message and unread counts",
    promptSnippet: "List Gmail folders with counts",
    parameters: Type.Object({ account: accountParam }),
    async execute(_toolCallId, params) {
      try {
        const folders = await listFolders(params.account);
        const text = folders.map((f) => `${f.name}  (${f.messages} messages, ${f.unread} unread)`).join("\n");
        return textResult(`Gmail folders:\n${text}`, { folders });
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  // ---- gmail_list ----------------------------------------------------------
  pi.registerTool({
    name: "gmail_list",
    label: "Gmail List",
    description:
      "List recent emails from a Gmail folder (newest first). Optional full-text query and unread-only filter.",
    promptSnippet: "List/search Gmail emails in a folder",
    parameters: Type.Object({
      folder: folderParam,
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 100, description: "Max emails to return (default 10)" }),
      ),
      unreadOnly: Type.Optional(Type.Boolean({ description: "Only unread messages (default false)" })),
      query: Type.Optional(Type.String({ description: "Optional full-text search term (IMAP SEARCH TEXT)" })),
      account: accountParam,
    }),
    async execute(_toolCallId, params) {
      try {
        const limit = params.limit ?? 10;
        const result = await listEmails({
          folder: params.folder,
          limit,
          unreadOnly: params.unreadOnly ?? false,
          query: params.query,
          account: params.account,
        });
        if (result.count === 0) {
          const q = params.query ? ` matching "${params.query}"` : "";
          return textResult(`No emails found in ${result.mailbox}${q}.`);
        }
        const lines = result.emails.map((e, i) => {
          const marks = [e.unread ? "unread" : null, e.starred ? "starred" : null].filter(Boolean).join(", ");
          return [
            `${i + 1}. [id: ${e.uid}]${marks ? ` (${marks})` : ""}`,
            `   From: ${e.from}`,
            `   Subject: ${e.subject}`,
            `   Date: ${e.date}`,
          ].join("\n");
        });
        const header = `${result.count} email(s) in ${result.mailbox}${params.query ? ` matching "${params.query}"` : ""} (newest first):\n`;
        return textResult(header + lines.join("\n\n"), { emails: result.emails });
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  // ---- gmail_read ----------------------------------------------------------
  pi.registerTool({
    name: "gmail_read",
    label: "Gmail Read",
    description: "Read a Gmail email by id (uid from gmail_list): headers, text body, and attachment list.",
    promptSnippet: "Read a Gmail email by id",
    parameters: Type.Object({
      id: Type.String({ description: "Message id (uid) from gmail_list" }),
      folder: folderParam,
      maxChars: Type.Optional(
        Type.Integer({ minimum: 200, maximum: 200000, description: "Max body chars (default 20000)" }),
      ),
      account: accountParam,
    }),
    async execute(_toolCallId, params) {
      try {
        const email = await readEmail(params.folder, params.id, params.maxChars ?? 20_000, params.account);
        const attachments = email.attachments.length
          ? email.attachments.map((a) => `${a.filename} (${a.size} bytes, ${a.contentType})`).join("; ")
          : "(none)";
        const text = [
          `From: ${email.from}`,
          email.to ? `To: ${email.to}` : null,
          email.cc ? `Cc: ${email.cc}` : null,
          `Subject: ${email.subject}`,
          `Date: ${email.date}`,
          email.messageId ? `Message-ID: ${email.messageId}` : null,
          email.unread ? "Status: unread" : null,
          `Attachments: ${attachments}`,
          "",
          "---",
          email.body,
        ]
          .filter((line): line is string => line !== null)
          .join("\n");
        return textResult(text, { email });
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  // ---- gmail_send ----------------------------------------------------------
  pi.registerTool({
    name: "gmail_send",
    label: "Gmail Send",
    description: sendDescription("new email"),
    promptSnippet: sendSnippet("new email"),
    parameters: Type.Object({
      to: Type.Union([Type.String(), Type.Array(Type.String())], { description: "Recipient(s)" }),
      subject: Type.String({ description: "Subject line" }),
      body: Type.String({ description: "Email body (plain text, or HTML when html=true)" }),
      cc: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "Cc recipient(s)" })),
      bcc: Type.Optional(
        Type.Union([Type.String(), Type.Array(Type.String())], {
          description: "Bcc recipient(s) — the configured default Bcc (settings.bcc) is always appended",
        }),
      ),
      html: Type.Optional(Type.Boolean({ description: "Treat body as HTML (default false)" })),
      account: accountParam,
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const to = toTextList(params.to);
        if (!to) throw new Error("Missing required parameter: to");
        const cc = toTextList(params.cc);
        const bcc = toTextList(params.bcc);
        const text = params.html ? undefined : params.body;
        const html = params.html ? params.body : undefined;

        const permission = await resolveSendPermission(ctx, { to: to.join(", "), subject: params.subject });
        if (permission.send) {
          const messageId = await sendMail({ to, cc, bcc, subject: params.subject, text, html }, params.account);
          return textResult(`Sent to ${to.join(", ")} — subject: "${params.subject}" (Message-ID: ${messageId})`);
        }
        const result = await createDraft({ to, cc, bcc, subject: params.subject, text, html }, params.account);
        return textResult(
          draftFallbackText(
            permission.reason ?? "sending was not permitted",
            result.mailbox,
            result.size,
            "This is the safe default — enable real sending with /gmail-config (allowSend).",
          ),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  // ---- gmail_reply ---------------------------------------------------------
  pi.registerTool({
    name: "gmail_reply",
    label: "Gmail Reply",
    description:
      "Reply to a Gmail email by id (uid). Uses the original Reply-To/Message-ID/References headers so it threads correctly. " +
      sendDescription("reply"),
    promptSnippet: sendSnippet("reply"),
    parameters: Type.Object({
      id: Type.String({ description: "Message id (uid) of the email to reply to" }),
      folder: folderParam,
      body: Type.String({ description: "Reply body (plain text, or HTML when html=true)" }),
      to: Type.Optional(Type.String({ description: "Override reply recipient (default: original Reply-To/From)" })),
      html: Type.Optional(Type.Boolean({ description: "Treat body as HTML (default false)" })),
      account: accountParam,
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const reply = await prepareReply(params.folder, params.id, params.to, params.account);
        const text = params.html ? undefined : params.body;
        const html = params.html ? params.body : undefined;

        const permission = await resolveSendPermission(ctx, { to: reply.to.join(", "), subject: reply.subject });
        if (permission.send) {
          const messageId = await sendMail(
            {
              to: reply.to,
              subject: reply.subject,
              text,
              html,
              inReplyTo: reply.inReplyTo,
              references: reply.references,
            },
            params.account,
          );
          return textResult(
            `Replied — to: ${reply.to.join(", ")}, subject: "${reply.subject}" (Message-ID: ${messageId})`,
          );
        }
        const result = await createDraft(
          {
            to: reply.to,
            subject: reply.subject,
            text,
            html,
            inReplyTo: reply.inReplyTo,
            references: reply.references,
          },
          params.account,
        );
        return textResult(
          draftFallbackText(
            permission.reason ?? "sending was not permitted",
            result.mailbox,
            result.size,
            "This is the safe default — enable real sending with /gmail-config (allowSend).",
          ),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  // ---- gmail_draft ---------------------------------------------------------
  pi.registerTool({
    name: "gmail_draft",
    label: "Gmail Draft",
    description: "Save a draft email to Gmail's Drafts folder (NOT sent). Optionally replace an existing draft by id.",
    promptSnippet: "Save a Gmail draft (not sent)",
    parameters: Type.Object({
      to: Type.Optional(
        Type.Union([Type.String(), Type.Array(Type.String())], { description: "Intended recipient(s)" }),
      ),
      subject: Type.String({ description: "Subject line" }),
      body: Type.String({ description: "Draft body (plain text, or HTML when html=true)" }),
      cc: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "Cc recipient(s)" })),
      bcc: Type.Optional(
        Type.Union([Type.String(), Type.Array(Type.String())], {
          description: "Bcc recipient(s) — the configured default Bcc (settings.bcc) is always appended",
        }),
      ),
      html: Type.Optional(Type.Boolean({ description: "Treat body as HTML (default false)" })),
      replaceDraftId: Type.Optional(
        Type.String({ description: "Uid of an existing draft to delete first (from gmail_list folder=drafts)" }),
      ),
      account: accountParam,
    }),
    async execute(_toolCallId, params) {
      try {
        const result = await createDraft(
          {
            to: toTextList(params.to),
            cc: toTextList(params.cc),
            bcc: toTextList(params.bcc),
            subject: params.subject,
            text: params.html ? undefined : params.body,
            html: params.html ? params.body : undefined,
            replaceDraftId: params.replaceDraftId,
          },
          params.account,
        );
        return textResult(
          `Draft saved to ${result.mailbox} (${result.size} bytes). It is NOT sent. List drafts with gmail_list folder=drafts.`,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  // ---- gmail_mark ----------------------------------------------------------
  pi.registerTool({
    name: "gmail_mark",
    label: "Gmail Mark",
    description: "Mark a Gmail email as read/unread or starred/unstarred.",
    promptSnippet: "Mark a Gmail email read/unread/starred",
    parameters: Type.Object({
      id: Type.String({ description: "Message id (uid)" }),
      folder: folderParam,
      flag: Type.Union([
        Type.Literal("read"),
        Type.Literal("unread"),
        Type.Literal("starred"),
        Type.Literal("unstarred"),
      ]),
      account: accountParam,
    }),
    async execute(_toolCallId, params) {
      try {
        const message = await markEmail(params.folder, params.id, params.flag, params.account);
        return textResult(message);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  // ---- gmail_move ----------------------------------------------------------
  pi.registerTool({
    name: "gmail_move",
    label: "Gmail Move",
    description: "Move a Gmail email to another folder/label (e.g. trash, spam, or a custom label).",
    promptSnippet: "Move a Gmail email to another folder/label",
    parameters: Type.Object({
      id: Type.String({ description: "Message id (uid)" }),
      folder: folderParam,
      to: Type.String({ description: "Destination folder/label (e.g. trash, spam, or a custom label name)" }),
      account: accountParam,
    }),
    async execute(_toolCallId, params) {
      try {
        const message = await moveEmail(params.folder, params.id, params.to, params.account);
        return textResult(message);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  // ---- gmail_save_attachment -----------------------------------------------
  pi.registerTool({
    name: "gmail_save_attachment",
    label: "Gmail Save Attachment",
    description: "Download an attachment from a Gmail email to a local file path (max 100 MB).",
    promptSnippet: "Save a Gmail email attachment to a file",
    parameters: Type.Object({
      id: Type.String({ description: "Message id (uid)" }),
      folder: folderParam,
      filename: Type.String({ description: "Exact attachment filename (from gmail_read, case-insensitive)" }),
      destPath: Type.String({ description: "Local file path to save to (parent dirs are created)" }),
      account: accountParam,
    }),
    async execute(_toolCallId, params) {
      try {
        const result = await saveAttachment({
          folder: params.folder,
          uid: params.id,
          filename: params.filename,
          destPath: params.destPath,
          account: params.account,
        });
        return textResult(`Saved attachment to ${result.path} (${result.size} bytes, ${result.contentType})`, result);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  // ---- /gmail-auth -----------------------------------------------------------
  pi.registerCommand("gmail-auth", {
    description: "Manage Gmail accounts (add, update, set default) and test the connection",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/gmail-auth requires interactive mode", "error");
        return;
      }

      const existing = listAccountSummaries();
      const updateLabel = (a: { name: string; email: string }) => `Update: ${a.name} — ${a.email}`;
      const choice = await ctx.ui.select("Gmail accounts — choose an action", [
        "Add a new account",
        ...existing.map(updateLabel),
        ...(existing.length > 0 ? ["Set default account"] : []),
        "Done (no changes)",
      ]);
      if (!choice || choice.startsWith("Done")) return;

      if (choice === "Set default account") {
        const pick = await ctx.ui.select(
          "Default account",
          existing.map((a) => `${a.name} — ${a.email}`),
        );
        if (!pick) return;
        const match = existing.find((a) => `${a.name} — ${a.email}` === pick);
        if (!match) {
          ctx.ui.notify(`Unknown choice: ${pick}`, "warning");
          return;
        }
        try {
          setDefaultAccount(match.name);
          ctx.ui.notify(`Default account set to ${match.name} (${match.email}).`, "info");
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Could not set default account: ${msg}`, "error");
        }
        return;
      }

      // "Add a new account" or "Update: <name> — <email>".
      let name: string | undefined;
      if (choice.startsWith("Update: ")) {
        const match = existing.find((a) => updateLabel(a) === choice);
        if (!match) {
          ctx.ui.notify(`Unknown choice: ${choice}`, "warning");
          return;
        }
        name = match.name;
      }

      const email = await ctx.ui.input(
        "Gmail account",
        name
          ? `Currently: ${existing.find((a) => a.name === name)?.email ?? ""} — enter email address:`
          : "Email address (e.g. support@plaincode.com):",
      );
      if (!email?.trim()) {
        ctx.ui.notify("Cancelled: no email address.", "error");
        return;
      }
      if (!name) {
        const enteredName = await ctx.ui.input(
          "Account name",
          "Short name (e.g. support) — leave empty to use the email address",
        );
        if (enteredName === undefined) {
          ctx.ui.notify("Cancelled.", "error");
          return;
        }
        name = enteredName.trim() || undefined;
      }
      const appPassword = await ctx.ui.input(
        "Gmail app password",
        "16-char app password from https://myaccount.google.com/apppasswords:",
      );
      if (!appPassword?.trim()) {
        ctx.ui.notify("Cancelled: no app password.", "error");
        return;
      }

      const creds: Credentials = { email: email.trim(), appPassword: appPassword.replace(/\s+/g, "") };

      // Test the connection before saving.
      const client = imapClientFactory(creds);
      let inbox: { messages: number; unread: number } | null = null;
      try {
        await client.connect();
        const list = await client.list({ statusQuery: { messages: true, unseen: true } });
        const found = list.find((m) => m.path === "INBOX");
        inbox = { messages: found?.status?.messages ?? 0, unread: found?.status?.unseen ?? 0 };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Connection failed: ${msg}`, "error");
        return;
      } finally {
        try {
          await client.logout();
        } catch {
          // ignore
        }
      }

      try {
        const key = saveAccount(name, creds.email, creds.appPassword);
        ctx.ui.notify(
          `Gmail account ${key} configured for ${creds.email}. Inbox: ${inbox ? `${inbox.messages} messages, ${inbox.unread} unread` : "ok"}. ` +
            `Sending mode: ${getSettings().allowSend ? "enabled" : "DRAFT-ONLY (default)"} — manage with /gmail-config.`,
          "info",
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Connected, but could not save config: ${msg}`, "warning");
      }
    },
  });

  // ---- /gmail-status ----------------------------------------------------------
  pi.registerCommand("gmail-status", {
    description: "Show Gmail accounts + settings and test the IMAP connection of each account",
    handler: async (_args, ctx) => {
      const norm = readNormalized();
      if (!norm) {
        ctx.ui.notify(NOT_CONFIGURED, "error");
        return;
      }
      const settings = norm.settings;
      const accountLines = Object.entries(norm.accounts).map(
        ([name, a]) => `  ${name} — ${a.email}${name === norm.defaultAccount ? " (default)" : ""}`,
      );
      ctx.ui.notify(
        `Accounts:\n${accountLines.join("\n")}\n` +
          `allowSend: ${settings.allowSend} — ${settings.allowSend ? "gmail_send/gmail_reply send emails" : "DRAFT-ONLY: gmail_send/gmail_reply save drafts, never send"}\n` +
          `confirmSends: ${settings.confirmSends} — ${settings.confirmSends ? "asks for confirmation before each send" : "sends without confirmation (when allowSend is true)"}`,
        "info",
      );
      for (const [name, creds] of Object.entries(norm.accounts)) {
        ctx.ui.notify(`Testing IMAP connection (${name} — ${creds.email})…`, "info");
        const client = imapClientFactory(creds);
        try {
          await client.connect();
          const list = await client.list({ statusQuery: { messages: true, unseen: true } });
          const inbox = list.find((m) => m.path === "INBOX");
          ctx.ui.notify(
            `Connected. ${list.length} folders. Inbox: ${inbox?.status ? `${inbox.status.messages ?? 0} messages, ${inbox.status.unseen ?? 0} unread` : "n/a"}.`,
            "info",
          );
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Connection failed: ${msg}`, "error");
        } finally {
          try {
            await client.logout();
          } catch {
            // ignore
          }
        }
      }
    },
  });

  // ---- /gmail-config ----------------------------------------------------------
  pi.registerCommand("gmail-config", {
    description:
      "Show Gmail settings (allowSend, confirmSends, bcc) and change them (persisted to config.json, mode 0600)",
    handler: async (_args, ctx) => {
      const settings = getSettings();
      const accounts = Object.entries(readNormalized()?.accounts ?? {}).map(([n, a]) => `${n} (${a.email})`);
      const bccText = settings.bcc?.length ? settings.bcc.join(", ") : "(none)";
      const summary =
        `Accounts: ${accounts.length ? accounts.join(", ") : "(none configured)"}\n` +
        `allowSend: ${settings.allowSend} — ${settings.allowSend ? "gmail_send/gmail_reply send emails" : "DRAFT-ONLY: gmail_send/gmail_reply save drafts, never send"}\n` +
        `confirmSends: ${settings.confirmSends} — ${settings.confirmSends ? "asks for confirmation before each send" : "sends without confirmation (when allowSend is true)"}\n` +
        `bcc: ${bccText} — always appended to Bcc ("self" = the sending account's own address)`;

      if (!ctx.hasUI) {
        ctx.ui.notify(summary, "info");
        return;
      }

      ctx.ui.notify(summary, "info");
      const choice = await ctx.ui.select("Gmail settings — choose an action", [
        settings.allowSend ? "Disable sending (allowSend → false)" : "Enable sending (allowSend → true)",
        settings.confirmSends
          ? "Disable send confirmation (confirmSends → false)"
          : "Enable send confirmation (confirmSends → true)",
        settings.bcc?.length
          ? `Clear default Bcc (bcc → none, currently ${settings.bcc.join(", ")})`
          : 'Set default Bcc to self (bcc → ["self"])',
        "Done (no changes)",
      ]);
      if (!choice || choice.startsWith("Done")) return;

      const next: Settings = { ...settings };
      if (choice.startsWith("Enable sending")) {
        next.allowSend = true;
        ctx.ui.notify(
          `allowSend = true. gmail_send/gmail_reply will now send${next.confirmSends ? " after interactive confirmation" : " without confirmation"}.`,
          "info",
        );
      } else if (choice.startsWith("Disable sending")) {
        next.allowSend = false;
        ctx.ui.notify("allowSend = false. DRAFT-ONLY mode: gmail_send/gmail_reply save drafts and never send.", "info");
      } else if (choice.startsWith("Disable send confirmation")) {
        next.confirmSends = false;
        ctx.ui.notify(
          "confirmSends = false. Sends will not ask for confirmation (headless sends allowed when allowSend=true).",
          "warning",
        );
      } else if (choice.startsWith("Enable send confirmation")) {
        next.confirmSends = true;
        ctx.ui.notify(
          "confirmSends = true. Each send asks for interactive confirmation; headless runs fall back to drafting.",
          "info",
        );
      } else if (choice.startsWith("Clear default Bcc")) {
        next.bcc = undefined;
        ctx.ui.notify("bcc = none. The default Bcc is no longer appended.", "info");
      } else if (choice.startsWith("Set default Bcc")) {
        next.bcc = ["self"];
        ctx.ui.notify('bcc = ["self"]. The sending account\'s own address is now always appended to Bcc.', "info");
      } else {
        ctx.ui.notify(`Unknown choice: ${choice}`, "warning");
        return;
      }

      try {
        saveSettings(next);
        ctx.ui.notify(`Settings saved to ${CONFIG_PATH} (mode 0600).`, "info");
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Could not save settings: ${msg}`, "error");
      }
    },
  });

  // ---- session_start notice ---------------------------------------------------
  pi.on("session_start", async (_event, ctx) => {
    const norm = readNormalized();
    const mode = getSettings().allowSend ? "sending enabled" : "DRAFT-ONLY mode (sending disabled)";
    if (norm) {
      const accounts = Object.entries(norm.accounts)
        .map(([n, a]) => `${a.email}${n === norm.defaultAccount ? " (default)" : ""}`)
        .join(", ");
      ctx.ui.notify(`Gmail ready: ${accounts} — ${mode}`, "info");
    } else {
      ctx.ui.notify(`Gmail extension loaded — run /gmail-auth to configure. ${mode}.`, "info");
    }
  });
}
