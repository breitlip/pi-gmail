/**
 * Shared test helpers: a mock pi ExtensionAPI that captures registrations,
 * plus fake IMAP/SMTP implementations for the enforcement tests.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

export interface MockTool {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  parameters: TSchema;
  execute: (...args: unknown[]) => Promise<unknown>;
}

export interface MockCommand {
  name: string;
  description?: string;
  handler: (args: string, ctx: unknown) => Promise<void>;
}

export interface MockPi {
  tools: MockTool[];
  commands: Map<string, MockCommand>;
  events: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
}

export function createMockPi(): { pi: ExtensionAPI; mock: MockPi } {
  const mock: MockPi = {
    tools: [],
    commands: new Map(),
    events: new Map(),
  };
  const pi = {
    registerTool(tool: MockTool): void {
      mock.tools.push(tool);
    },
    registerCommand(name: string, options: Omit<MockCommand, "name">): void {
      mock.commands.set(name, { name, ...options });
    },
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void {
      mock.events.set(event, [...(mock.events.get(event) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  return { pi, mock };
}

export function getTool(mock: MockPi, name: string): MockTool {
  const tool = mock.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  return tool;
}

// ---------------------------------------------------------------------------
// Fake IMAP client (records appends, serves a canned original message)
// ---------------------------------------------------------------------------

export const ORIGINAL_MIME = [
  "From: Alice Example <alice@example.com>",
  "To: me@example.com",
  "Subject: Hello",
  "Message-ID: <orig-123@example.com>",
  "References: <a@example.com> <b@example.com>",
  "",
  "Original body text",
].join("\r\n");

export interface FakeImapCalls {
  appends: Array<{ path: string; content: Buffer; flags: string[] }>;
  deletes: string[];
}

export function makeFakeImap() {
  const calls: FakeImapCalls = { appends: [], deletes: [] };
  const client = {
    connect: async () => {},
    logout: async () => {},
    mailboxOpen: async (path: string) => ({ path }),
    mailboxClose: async () => true,
    list: async () => [
      { path: "INBOX", status: { messages: 3, unseen: 1 } },
      { path: "[Gmail]/Drafts", status: { messages: 1, unseen: 0 } },
    ],
    fetchOne: async (_seq: string, query: Record<string, unknown>) => {
      if (query.source) return { uid: 1, source: Buffer.from(ORIGINAL_MIME) };
      if (query.envelope) {
        return {
          uid: 1,
          envelope: {
            from: [{ address: "alice@example.com", name: "Alice Example" }],
            subject: "Hello",
            date: new Date("2025-01-01T00:00:00Z"),
          },
          flags: new Set<string>(),
        };
      }
      return false;
    },
    append: async (path: string, content: Buffer | string, flags: string[]) => {
      calls.appends.push({ path, content: Buffer.isBuffer(content) ? content : Buffer.from(content), flags });
      return { destination: path };
    },
    messageDelete: async (uid: string) => {
      calls.deletes.push(uid);
      return true;
    },
  };
  return { client, calls };
}

// ---------------------------------------------------------------------------
// SMTP transport spy
// ---------------------------------------------------------------------------

export interface SmtpSpy {
  attempts: Array<Record<string, unknown>>;
  factory: (opts: Record<string, unknown>) => {
    sendMail: (mail: Record<string, unknown>) => Promise<{ messageId: string }>;
    close: () => void;
  };
  sentMails: Record<string, unknown>[];
}

/**
 * Records every SMTP transport creation (i.e. every real-send attempt) and
 * either fails (failMode) or returns a canned success.
 */
export function makeSmtpSpy(failMode = false): SmtpSpy {
  const spy: SmtpSpy = {
    attempts: [],
    sentMails: [],
    factory: (opts) => {
      spy.attempts.push(opts);
      return {
        sendMail: async (mail) => {
          if (failMode) throw new Error("SMTP send attempted — must not happen in draft-only tests");
          spy.sentMails.push(mail);
          return { messageId: "<sent-1@example.com>" };
        },
        close: () => {},
      };
    },
  };
  return spy;
}

// ---------------------------------------------------------------------------
// Mock command/tool context (ctx.ui.confirm / select / input / notify)
// ---------------------------------------------------------------------------

export interface MockCtxOptions {
  hasUI?: boolean;
  confirmAnswer?: boolean;
  /** Single answer returned by every select() call. */
  selectAnswer?: string;
  /** Queue of answers for consecutive select() calls (shifted per call). */
  selectAnswers?: string[];
  inputAnswers?: string[];
}

export interface MockCtx {
  ctx: {
    hasUI: boolean;
    ui: {
      confirm: (title: string, message: string) => Promise<boolean>;
      notify: (message: string, type?: string) => void;
      input: (title: string, placeholder?: string) => Promise<string | undefined>;
      select: (title: string, options: string[]) => Promise<string | undefined>;
    };
  };
  confirmCalls: string[];
  notifications: Array<{ message: string; type?: string }>;
  selectCalls: string[][];
  selectQueue: string[];
  inputQueue: string[];
}

export function makeCtx(options: MockCtxOptions = {}): MockCtx {
  const result: MockCtx = {
    ctx: {
      hasUI: options.hasUI ?? true,
      ui: {
        confirm: async (_title, message) => {
          result.confirmCalls.push(message);
          return options.confirmAnswer ?? true;
        },
        notify: (message, type) => {
          result.notifications.push({ message, type });
        },
        input: async () => {
          const next = result.inputQueue.shift();
          return next;
        },
        select: async (_title, optionsList) => {
          result.selectCalls.push(optionsList);
          return result.selectQueue.shift() ?? options.selectAnswer;
        },
      },
    },
    confirmCalls: [],
    notifications: [],
    selectCalls: [],
    selectQueue: options.selectAnswers ?? [],
    inputQueue: options.inputAnswers ?? [],
  };
  return result;
}
