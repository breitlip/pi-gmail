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
 * Tools:
 *   gmail_folders, gmail_list, gmail_read, gmail_send, gmail_reply, gmail_draft,
 *   gmail_mark, gmail_move, gmail_save_attachment
 * Commands:
 *   /gmail-auth, /gmail-status
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Config & credentials
// ---------------------------------------------------------------------------

const CONFIG_PATH = join(homedir(), ".pi", "agent", "extensions", "gmail", "config.json");

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

function resolveFolder(folder?: string): string {
  if (!folder) return "INBOX";
  const key = folder.trim().toLowerCase();
  return FOLDER_ALIASES[key] ?? folder.trim();
}

interface Credentials {
  email: string;
  appPassword: string;
}

function getCredentials(): Credentials | null {
  const envEmail = process.env.GMAIL_EMAIL?.trim();
  const envPass = process.env.GMAIL_APP_PASSWORD?.trim();
  if (envEmail && envPass) {
    return { email: envEmail, appPassword: envPass.replace(/\s+/g, "") };
  }
  if (existsSync(CONFIG_PATH)) {
    try {
      const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as { email?: string; appPassword?: string };
      if (cfg.email?.trim() && cfg.appPassword) {
        return { email: cfg.email.trim(), appPassword: cfg.appPassword.replace(/\s+/g, "") };
      }
    } catch {
      // Corrupt config — treat as unconfigured.
    }
  }
  return null;
}

const NOT_CONFIGURED =
  "Gmail is not configured. Run /gmail-auth in pi, or set GMAIL_EMAIL and GMAIL_APP_PASSWORD. " +
  "App passwords: https://myaccount.google.com/apppasswords (requires 2-Step Verification).";

function requireCredentials(): Credentials {
  const creds = getCredentials();
  if (!creds) throw new Error(NOT_CONFIGURED);
  return creds;
}

function imapClient(creds: Credentials): ImapFlow {
  return new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: creds.email, pass: creds.appPassword },
    logger: false,
    connectTimeout: 20_000,
  });
}

async function withImap<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const creds = requireCredentials();
  const client = imapClient(creds);
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Address {
  name?: string;
  address?: string;
}

function formatAddress(addr?: Address): string {
  if (!addr?.address) return "unknown";
  return addr.name ? `${addr.name} <${addr.address}>` : addr.address;
}

function formatAddresses(addrs?: Address[]): string {
  if (!addrs?.length) return "";
  return addrs.map((a) => formatAddress(a)).join(", ");
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n… [truncated at ${maxChars} chars]`;
}

function toTextList(value: string | string[] | undefined): string[] | undefined {
  if (!value) return undefined;
  const list = (Array.isArray(value) ? value : [value]).map((s) => s.trim()).filter(Boolean);
  return list.length ? list : undefined;
}

// ---------------------------------------------------------------------------
// IMAP operations
// ---------------------------------------------------------------------------

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
}): Promise<{ mailbox: string; count: number; emails: EmailSummary[] }> {
  return withImap(async (client) => {
    const mailbox = resolveFolder(opts.folder);
    await client.mailboxOpen(mailbox, { readOnly: true });

    let uids: number[] = opts.query
      ? ((await client.search({ text: opts.query }, { uid: true })) ?? [])
      : ((await client.search({}, { uid: true })) ?? []);
    if (opts.unreadOnly) {
      const unseen = new Set((await client.search({ seen: false }, { uid: true })) ?? []);
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
  });
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

async function readEmail(folder: string | undefined, uid: string, maxChars: number): Promise<EmailDetail> {
  return withImap(async (client) => {
    const mailbox = resolveFolder(folder);
    await client.mailboxOpen(mailbox, { readOnly: true });
    const msg = await client.fetchOne(uid, { envelope: true, flags: true, source: true }, { uid: true });
    if (!msg || !msg.source) throw new Error(`Message uid ${uid} not found in ${mailbox}`);

    const parsed = await simpleParser(msg.source, { skipHtmlToText: true });
    const flags = msg.flags ?? new Set<string>();
    const body = (parsed.text || parsed.html || "(empty body)").trim();

    return {
      uid: String(msg.uid),
      from: formatAddress(parsed.from),
      to: formatAddresses(parsed.to),
      cc: formatAddresses(parsed.cc),
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
  });
}

async function markEmail(
  folder: string | undefined,
  uid: string,
  flag: "read" | "unread" | "starred" | "unstarred"
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
  });
  return `Marked message ${uid} as ${flag}`;
}

async function moveEmail(folder: string | undefined, uid: string, to: string): Promise<string> {
  const dest = resolveFolder(to);
  await withImap(async (client) => {
    const mailbox = resolveFolder(folder);
    await client.mailboxOpen(mailbox, { readOnly: false });
    await client.messageMove(uid, dest, { uid: true });
  });
  return `Moved message ${uid} to ${dest}`;
}

async function listFolders(): Promise<{ name: string; messages: number; unread: number }[]> {
  return withImap(async (client) => {
    const list = await client.list();
    return list.map((m) => ({ name: m.path, messages: m.exists ?? 0, unread: m.unseen ?? 0 }));
  });
}

interface StructureNode {
  part?: string;
  type: string;
  disposition?: string;
  dispositionParameters?: Record<string, string>;
  childNodes?: StructureNode[];
}

function findAttachmentPart(node: StructureNode, filename: string): { key: string; contentType: string } | null {
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
}): Promise<{ path: string; size: number; contentType: string }> {
  const MAX_BYTES = 100 * 1024 * 1024;
  return withImap(async (client) => {
    const mailbox = resolveFolder(opts.folder);
    await client.mailboxOpen(mailbox, { readOnly: true });

    const msg = await client.fetchOne(opts.uid, { bodyStructure: true }, { uid: true });
    if (!msg?.bodyStructure) throw new Error(`Message uid ${opts.uid} not found in ${mailbox}`);

    const part = findAttachmentPart(msg.bodyStructure as StructureNode, opts.filename);
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
  });
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

// Some networks block implicit-TLS 465 but allow STARTTLS 587 (or vice versa),
// so try both with short explicit timeouts instead of hanging on the default 2 min.
const SMTP_ENDPOINTS: Array<{ host: string; port: number; secure: boolean }> = [
  { host: "smtp.gmail.com", port: 587, secure: false }, // STARTTLS
  { host: "smtp.gmail.com", port: 465, secure: true }, // implicit TLS
];

async function sendMail(opts: SendOptions): Promise<string> {
  const creds = requireCredentials();
  const mail = {
    from: creds.email,
    to: opts.to.join(","),
    cc: opts.cc?.join(","),
    bcc: opts.bcc?.join(","),
    subject: opts.subject,
    text: opts.text,
    html: opts.html,
    inReplyTo: opts.inReplyTo,
    references: opts.references,
  };

  let lastError: unknown = null;
  for (const endpoint of SMTP_ENDPOINTS) {
    const transporter = nodemailer.createTransport({
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

async function replyEmail(opts: {
  folder?: string;
  uid: string;
  body: string;
  html: boolean;
  toOverride?: string;
}): Promise<{ messageId: string; to: string; subject: string }> {
  const original = await withImap(async (client) => {
    const mailbox = resolveFolder(opts.folder);
    await client.mailboxOpen(mailbox, { readOnly: true });
    const msg = await client.fetchOne(opts.uid, { source: true }, { uid: true });
    if (!msg?.source) throw new Error(`Message uid ${opts.uid} not found in ${mailbox}`);
    return simpleParser(msg.source, { skipHtmlToText: true });
  });

  const replyToHeader = original.headers?.get("reply-to");
  const to = opts.toOverride
    ? [opts.toOverride.trim()]
    : replyToHeader
      ? replyToHeader.split(",").map((s) => s.trim()).filter(Boolean)
      : [original.from?.address ?? ""].filter(Boolean);
  if (!to.length) throw new Error("Could not determine reply recipient (no Reply-To or From header)");

  const subject = /^re:/i.test(original.subject ?? "")
    ? (original.subject as string)
    : `Re: ${original.subject ?? ""}`;

  const messageId = await sendMail({
    to,
    subject,
    text: opts.html ? undefined : opts.body,
    html: opts.html ? opts.body : undefined,
    inReplyTo: original.messageId,
    references: original.messageId
      ? [...(original.references ?? []), original.messageId]
      : undefined,
  });

  return { messageId, to: to.join(", "), subject };
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

const DRAFTS_FOLDER = "[Gmail]/Drafts";

async function createDraft(opts: {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  replaceDraftId?: string;
}): Promise<{ mailbox: string; size: number }> {
  const creds = requireCredentials();

  // Build the raw MIME message without sending (stream transport, buffer: true
  // because nodemailer v10 returns a Stream by default).
  const transporter = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const { message } = await transporter.sendMail({
    from: creds.email,
    to: opts.to?.join(","),
    cc: opts.cc?.join(","),
    bcc: opts.bcc?.join(","),
    subject: opts.subject,
    text: opts.text,
    html: opts.html,
  });
  const raw = Buffer.isBuffer(message) ? message : Buffer.from(message as string, "utf8");

  return withImap(async (client) => {
    if (opts.replaceDraftId) {
      await client.mailboxOpen(DRAFTS_FOLDER, { readOnly: false });
      await client.messageDelete(opts.replaceDraftId, { uid: true });
      await client.mailboxClose();
    }
    const res = await client.append(DRAFTS_FOLDER, raw, ["\\Draft"]);
    if (res === false) throw new Error("Gmail rejected the draft append");
    return { mailbox: res.destination, size: raw.length };
  });
}

// ---------------------------------------------------------------------------
// Tool result helpers
// ---------------------------------------------------------------------------

function textResult(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

function errorResult(error: unknown) {
  const err = error as (Error & { responseText?: string; executedCommand?: string }) | null;
  let msg = err?.message ?? String(error);
  if (err?.responseText) msg += ` — server said: ${err.responseText}`;
  if (err?.executedCommand) msg += ` — command: ${err.executedCommand}`;
  return { content: [{ type: "text" as const, text: `Gmail error: ${msg}` }], isError: true };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const folderParam = Type.Optional(
  Type.String({
    description:
      'Folder: inbox, sent, starred, drafts, spam, trash, important, all — or an exact label/folder name (default: "inbox")',
  })
);

export default function (pi: ExtensionAPI) {
  // ---- gmail_folders -------------------------------------------------------
  pi.registerTool({
    name: "gmail_folders",
    label: "Gmail Folders",
    description: "List Gmail folders/labels with message and unread counts",
    promptSnippet: "List Gmail folders with counts",
    parameters: Type.Object({}),
    async execute() {
      try {
        const folders = await listFolders();
        const text = folders
          .map((f) => `${f.name}  (${f.messages} messages, ${f.unread} unread)`)
          .join("\n");
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
    description: "List recent emails from a Gmail folder (newest first). Optional full-text query and unread-only filter.",
    promptSnippet: "List/search Gmail emails in a folder",
    parameters: Type.Object({
      folder: folderParam,
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Max emails to return (default 10)" })),
      unreadOnly: Type.Optional(Type.Boolean({ description: "Only unread messages (default false)" })),
      query: Type.Optional(Type.String({ description: "Optional full-text search term (IMAP SEARCH TEXT)" })),
    }),
    async execute(_toolCallId, params) {
      try {
        const limit = params.limit ?? 10;
        const result = await listEmails({
          folder: params.folder,
          limit,
          unreadOnly: params.unreadOnly ?? false,
          query: params.query,
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
      maxChars: Type.Optional(Type.Integer({ minimum: 200, maximum: 200000, description: "Max body chars (default 20000)" })),
    }),
    async execute(_toolCallId, params) {
      try {
        const email = await readEmail(params.folder, params.id, params.maxChars ?? 20_000);
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
    description: "Send a new email from the configured Gmail account.",
    promptSnippet: "Send a new Gmail email",
    parameters: Type.Object({
      to: Type.Union([Type.String(), Type.Array(Type.String())], { description: "Recipient(s)" }),
      subject: Type.String({ description: "Subject line" }),
      body: Type.String({ description: "Email body (plain text, or HTML when html=true)" }),
      cc: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "Cc recipient(s)" })),
      bcc: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "Bcc recipient(s)" })),
      html: Type.Optional(Type.Boolean({ description: "Treat body as HTML (default false)" })),
    }),
    async execute(_toolCallId, params) {
      try {
        const to = toTextList(params.to);
        if (!to) throw new Error("Missing required parameter: to");
        const messageId = await sendMail({
          to,
          cc: toTextList(params.cc),
          bcc: toTextList(params.bcc),
          subject: params.subject,
          text: params.html ? undefined : params.body,
          html: params.html ? params.body : undefined,
        });
        return textResult(`Sent to ${to.join(", ")} — subject: "${params.subject}" (Message-ID: ${messageId})`);
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
      "Reply to a Gmail email by id (uid). Uses the original Reply-To/Message-ID/References headers so it threads correctly.",
    promptSnippet: "Reply to a Gmail email by id",
    parameters: Type.Object({
      id: Type.String({ description: "Message id (uid) of the email to reply to" }),
      folder: folderParam,
      body: Type.String({ description: "Reply body (plain text, or HTML when html=true)" }),
      to: Type.Optional(Type.String({ description: "Override reply recipient (default: original Reply-To/From)" })),
      html: Type.Optional(Type.Boolean({ description: "Treat body as HTML (default false)" })),
    }),
    async execute(_toolCallId, params) {
      try {
        const result = await replyEmail({
          folder: params.folder,
          uid: params.id,
          body: params.body,
          html: params.html ?? false,
          toOverride: params.to,
        });
        return textResult(`Replied — to: ${result.to}, subject: "${result.subject}" (Message-ID: ${result.messageId})`);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  // ---- gmail_draft ---------------------------------------------------------
  pi.registerTool({
    name: "gmail_draft",
    label: "Gmail Draft",
    description:
      "Save a draft email to Gmail's Drafts folder (NOT sent). Optionally replace an existing draft by id.",
    promptSnippet: "Save a Gmail draft (not sent)",
    parameters: Type.Object({
      to: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "Intended recipient(s)" })),
      subject: Type.String({ description: "Subject line" }),
      body: Type.String({ description: "Draft body (plain text, or HTML when html=true)" }),
      cc: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "Cc recipient(s)" })),
      bcc: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "Bcc recipient(s)" })),
      html: Type.Optional(Type.Boolean({ description: "Treat body as HTML (default false)" })),
      replaceDraftId: Type.Optional(
        Type.String({ description: "Uid of an existing draft to delete first (from gmail_list folder=drafts)" })
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        const result = await createDraft({
          to: toTextList(params.to),
          cc: toTextList(params.cc),
          bcc: toTextList(params.bcc),
          subject: params.subject,
          text: params.html ? undefined : params.body,
          html: params.html ? params.body : undefined,
          replaceDraftId: params.replaceDraftId,
        });
        return textResult(
          `Draft saved to ${result.mailbox} (${result.size} bytes). It is NOT sent. List drafts with gmail_list folder=drafts.`
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
    }),
    async execute(_toolCallId, params) {
      try {
        const message = await markEmail(params.folder, params.id, params.flag);
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
    }),
    async execute(_toolCallId, params) {
      try {
        const message = await moveEmail(params.folder, params.id, params.to);
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
      filename: Type.String({ description: 'Exact attachment filename (from gmail_read, case-insensitive)' }),
      destPath: Type.String({ description: "Local file path to save to (parent dirs are created)" }),
    }),
    async execute(_toolCallId, params) {
      try {
        const result = await saveAttachment({
          folder: params.folder,
          uid: params.id,
          filename: params.filename,
          destPath: params.destPath,
        });
        return textResult(`Saved attachment to ${result.path} (${result.size} bytes, ${result.contentType})`, result);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  // ---- /gmail-auth -----------------------------------------------------------
  pi.registerCommand("gmail-auth", {
    description: "Configure Gmail credentials (email + app password) and test the connection",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/gmail-auth requires interactive mode", "error");
        return;
      }

      const existing = getCredentials();
      const email = await ctx.ui.input("Gmail account", "Email address (e.g. support@plaincode.com):", existing?.email ?? "");
      if (!email?.trim()) {
        ctx.ui.notify("Cancelled: no email address.", "error");
        return;
      }
      const appPassword = await ctx.ui.input(
        "Gmail app password",
        "16-char app password from https://myaccount.google.com/apppasswords:"
      );
      if (!appPassword?.trim()) {
        ctx.ui.notify("Cancelled: no app password.", "error");
        return;
      }

      const creds: Credentials = { email: email.trim(), appPassword: appPassword.replace(/\s+/g, "") };

      // Test the connection before saving.
      const client = imapClient(creds);
      let folders: { name: string; messages: number; unread: number }[] = [];
      try {
        await client.connect();
        const list = await client.list();
        folders = list.map((m) => ({ name: m.path, messages: m.exists ?? 0, unread: m.unseen ?? 0 }));
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
        mkdirSync(dirname(CONFIG_PATH), { recursive: true });
        writeFileSync(CONFIG_PATH, JSON.stringify(creds, null, 2) + "\n");
        chmodSync(CONFIG_PATH, 0o600);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Connected, but could not save config: ${msg}`, "warning");
        return;
      }

      const inbox = folders.find((f) => f.name === "INBOX");
      ctx.ui.notify(
        `Gmail configured for ${creds.email}. Inbox: ${inbox ? `${inbox.messages} messages, ${inbox.unread} unread` : "ok"}.`,
        "success"
      );
    },
  });

  // ---- /gmail-status ----------------------------------------------------------
  pi.registerCommand("gmail-status", {
    description: "Show Gmail config and test the IMAP connection",
    handler: async (_args, ctx) => {
      const creds = getCredentials();
      if (!creds) {
        ctx.ui.notify(NOT_CONFIGURED, "error");
        return;
      }
      ctx.ui.notify(`Account: ${creds.email} (testing connection…)`, "info");
      const client = imapClient(creds);
      try {
        await client.connect();
        const list = await client.list();
        const inbox = list.find((m) => m.path === "INBOX");
        ctx.ui.notify(
          `Connected. ${list.length} folders. Inbox: ${inbox ? `${inbox.exists ?? 0} messages, ${inbox.unseen ?? 0} unread` : "n/a"}.`,
          "success"
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
    },
  });

  // ---- session_start notice ---------------------------------------------------
  pi.on("session_start", async (_event, ctx) => {
    const creds = getCredentials();
    if (creds) {
      ctx.ui.notify(`Gmail ready: ${creds.email}`, "info");
    } else {
      ctx.ui.notify("Gmail extension loaded — run /gmail-auth to configure.", "info");
    }
  });
}
