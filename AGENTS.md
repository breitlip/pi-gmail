# AGENTS.md — working on pi-gmail

Guidance for AI agents (and humans) making changes in this repo. The user-facing
docs are in [README.md](README.md); this file covers structure, invariants, and
gotchas.

## What this is

A **single-file pi extension** (`index.ts`) that exposes Gmail to pi as tools,
via local IMAP/SMTP with a Google app password. No third-party cloud. pi loads
`index.ts` with jiti; the pi extension API (`ExtensionAPI`, `ctx.ui.*`,
`AgentToolResult`) is typed from the published `@earendil-works/pi-coding-agent`
package (devDependency).

## Hard rules

- **Keep the extension a single file** (`index.ts`) unless there is a strong reason.
- **Never rename tools or change parameter shapes** — other pi sessions rely on
  `gmail_folders`, `gmail_list`, `gmail_read`, `gmail_send`, `gmail_reply`,
  `gmail_draft`, `gmail_mark`, `gmail_move`, `gmail_save_attachment` and their
  current parameters.
- **Draft-only is the safe default.** `allowSend` defaults to `false`; do not
  flip the default or make sending reachable without an explicit user toggle.
- **Never commit `config.json`, `node_modules`, or credentials** (gitignored).
  Every write of the config file must `chmod 0600`.
- Tool results must always state what actually happened: `Sent … (Message-ID: …)`
  vs `NOT SENT — <reason> … saved as a draft`.

## Commands

```bash
npm run check     # lint (biome) + typecheck (tsc) + tests — must pass before pushing
npm test          # node --test via jiti/register: helpers, registration, enforcement
npm run test:live # + live IMAP tests (needs valid credentials; sets GMAIL_LIVE=1 itself)
npm run lint      # biome check .
npm run format    # biome check --write .
npm run typecheck # tsc --noEmit
```

CI (`.github/workflows/ci.yml`) runs `npm ci && npm run check` on push/PR.

## Architecture notes

- **Config path is fixed at module load**: `CONFIG_PATH` reads
  `GMAIL_CONFIG_PATH` (or the default `~/.pi/agent/extensions/gmail/config.json`)
  once, when `index.ts` is evaluated. Tests therefore set the env var **before**
  dynamically importing `index.ts`.
- **Settings are read from disk at call time** (`getSettings()` per
  invocation), so `/gmail-config` toggles take effect immediately without
  re-registering tools. Tool *descriptions* are computed at registration time —
  they reflect the mode at load, while result text always reflects reality.
- **Send guard**: `resolveSendPermission(ctx, {to, subject})` implements the
  matrix — `allowSend=false` → draft; `confirmSends=true` + no UI (headless) →
  refuse + draft; `confirmSends=true` + UI → `ctx.ui.confirm`, decline → draft;
  `confirmSends=false` → send.
- **Test seams** (named exports, used only by tests):
  `__setImapClientFactory(fn|null)` and `__setSmtpTransportFactory(fn|null)`
  (pass `null` to restore defaults). The enforcement test relies on the SMTP
  factory *never being called* when `allowSend=false`.
- **Drafts**: `buildRawMail()` builds MIME with a nodemailer stream transport
  (no network), then IMAP `APPEND` to `[Gmail]/Drafts` with `\Draft`.
- **Replies**: `prepareReply()` fetches the original once and derives
  `to`/`subject`/`inReplyTo`/`references`; both the send and the draft path use
  the same derived headers.
- Config file shape: `{ email, appPassword, settings: { allowSend, confirmSends } }`.
  Legacy two-key files must keep working (missing `settings` ⇒ safe defaults).

## Gotchas (learned the hard way — do not regress)

- **mailparser v3 address shape**: `from`/`to`/`cc` and address headers come
  back as `{ value: [{name, address}], html, text }`, *not* `{name, address}`.
  Always normalize with `toAddressList()`. (The old code assumed the flat shape
  and silently broke `gmail_read` From/To/Cc and reply-recipient detection.)
- **imapflow return types**: `fetchOne()` → `false | FetchMessageObject |
  undefined` (check `!msg || !msg.x` — optional-chain narrowing misses the
  `false` member); `search()` → `number[] | false | undefined` (use `|| []`,
  not `?? []`); folder counts require `client.list({ statusQuery: { messages:
  true, unseen: true } })` and then `m.status?.messages` (plain `list()` has no
  counts); the option is `connectionTimeout`, not `connectTimeout`.
- **pi UI API**: `ctx.ui.notify(msg, type)` accepts only `"info" | "warning" |
  "error"` (no `"success"`); `ctx.ui.input(title, placeholder)` — the second
  arg is a placeholder, not a default value; `ctx.ui.select(title, options)`
  returns the chosen option string (or `undefined` if dismissed).
- **Tool execute signature**: `execute(toolCallId, params, signal, onUpdate,
  ctx)` — `ctx` (with `hasUI`/`ui`) is the 5th argument.
- **Typecheck setup**: `tsconfig.json` needs `allowImportingTsExtensions`
  (pi's `.d.ts` files import `.ts` paths) with `noEmit`; `skipLibCheck` is on.
  `package.json` has `"type": "module"` so tsc treats the TS files as ESM
  (matches how jiti loads them; enables top-level await in tests).
- **Tests**: `node --import jiti/register --test "test/*.test.ts"` (Node here
  has no native TS support). Each test file runs in its own process; top-level
  await is fine. Post-load monkey-patching of `nodemailer`/`imapflow` does NOT
  affect the jiti-loaded module — use the seams instead.
- **Biome**: `complexity/useOptionalChain` is disabled in `biome.json` because
  it suggests `!msg?.x` which is wrong for `false | object` unions.
- **`AgentToolResult`** has no `isError` field in pi's types, but the runtime
  honors it (pi's own extensions use it); the local `ToolResult` type extends it.

## Live install & release flow

- The dev machine's live install is `~/.pi/agent/extensions/gmail` — a **git
  clone of this repo** with an **untracked `config.json`** (the real
  credentials). After pushing to `main`:

  ```bash
  cd ~/.pi/agent/extensions/gmail && git pull && npm install
  # verify: config.json still present, mode 600; git status clean
  ```

  Alternative: install as a pi package with
  `pi install git:github.com/breitlip/pi-gmail` (clones into
  `~/.pi/agent/git/...`, runs `npm install`). The config file is unaffected
  either way — `CONFIG_PATH` is fixed at
  `~/.pi/agent/extensions/gmail/config.json` regardless of where the code lives.

- Smoke-test that pi still loads the extension, e.g.:

  ```bash
  pi -p "Use the gmail_folders tool and report the first 3 folders. If missing, say TOOL_MISSING"
  ```

  Draft-only behavior check: asking pi to call `gmail_send` must return
  `NOT SENT — sending is disabled (allowSend=false — draft-only mode) …` and
  create a draft in `[Gmail]/Drafts` (clean up test drafts afterwards via IMAP
  `search` + `messageDelete`).
- Commit with clear messages; push to `main` on `origin`
  (`git@github.com:breitlip/pi-gmail.git`). CI must be green before syncing the
  live install.
