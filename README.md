# pi-gmail — local Gmail tools for pi

Gmail access for pi via **local IMAP/SMTP with an app password**. No third-party
cloud is involved; the only remote peers are Google's IMAP/SMTP servers.

## One-time setup

1. Make sure **2-Step Verification** is on for the Google account.
2. Generate an **app password**: <https://myaccount.google.com/apppasswords>
   (a 16-character code like `abcd efgh ijkl mnop`).
3. In pi, run:

   ```
   /gmail-auth
   ```

   It tests the IMAP connection, then saves credentials to
   `~/.pi/agent/extensions/gmail/config.json` (mode 0600).

   Alternative: set `GMAIL_EMAIL` and `GMAIL_APP_PASSWORD` environment
   variables (env vars take precedence over the config file).

## Sending is off by default (draft-only mode)

**`gmail_send` and `gmail_reply` do not send email out of the box.** With the
default settings they compose the exact mail that would have been sent (replies
keep their `In-Reply-To`/`References` threading headers) and save it to
`[Gmail]/Drafts` instead. You review it and send it yourself from Gmail.

This is a deliberate security default: an LLM tool that can send email can
phish, leak, or commit you — so the safe state is "can prepare, can't send".

The behavior is controlled by two settings (see below):

| `allowSend` | `confirmSends` | Behavior of `gmail_send` / `gmail_reply` |
| --- | --- | --- |
| `false` **(default)** | any | **Never sends.** Saves a draft to `[Gmail]/Drafts`. No SMTP connection is opened. |
| `true` | `true` **(default)** | Asks for interactive confirmation right before sending. Declining (or running headless with no UI) falls back to saving a draft. |
| `true` | `false` | Sends without confirmation — including headless. Only use this deliberately. |

Tool descriptions/prompts reflect the active mode so the LLM knows what will
happen, and every tool result states explicitly whether the mail was sent or
saved as a draft.

### Enabling real sending

Run `/gmail-config` in pi and choose **Enable sending**. This sets
`allowSend: true` (with `confirmSends` still `true`, so each send asks for
confirmation). To allow unattended/headless sending you must additionally
disable send confirmation — understand that this lets pi send email with no
human in the loop.

> **Security note:** the app password in `config.json` grants full send/read
> access to the mailbox. The file is `chmod 600` and gitignored, but treat
> `allowSend: true` (especially with `confirmSends: false`) as giving the
> model a live email account. Revoke app passwords any time at
> <https://myaccount.google.com/apppasswords>.

## Multi-account

You can configure several Google accounts in one config file. Every tool
accepts an optional **`account`** parameter — an account name or email
address (e.g. `"support"` or `"support@plaincode.com"`, case-insensitive, the
local part before the `@` also works). Without it:

- one account configured → that account is used
- several configured → the **default account** is used (set with
  `/gmail-auth` → *Set default account*), or the tool errors and lists the
  configured accounts

`GMAIL_EMAIL` / `GMAIL_APP_PASSWORD` env overrides still apply, but only when
a tool call does **not** name an account (env wins over the file, as before).

## Settings & config file

The config file next to the extension (default:
`~/.pi/agent/extensions/gmail/config.json`, overridable with
`GMAIL_CONFIG_PATH`) holds credentials **and** settings:

```json
{
  "defaultAccount": "support",
  "accounts": {
    "support": { "email": "support@example.com", "appPassword": "abcd efgh ijkl mnop" },
    "pb": { "email": "pb@example.com", "appPassword": "qrst uvwx yzab 1234" }
  },
  "settings": { "allowSend": false, "confirmSends": true, "bcc": ["self"] }
}
```

- **Backward compatible:** the legacy single-account shape
  (`{ "email", "appPassword", "settings" }`) keeps working — it is treated as
  one account (keyed by its email address, implicitly the default) and
  migrated to the multi-account shape the next time the config is written.
  Missing `settings` fall back to the safe defaults
  (`allowSend: false`, `confirmSends: true`).
- **`settings.bcc`** (optional): addresses always appended to Bcc on
  `gmail_send` / `gmail_reply` / `gmail_draft` (deduped against the per-call
  `bcc` parameter). The special value `"self"` resolves to the sending
  account's own email address — e.g. `"bcc": ["self"]` keeps a copy of every
  outgoing mail in the sender's inbox. Default: none.
- `/gmail-auth` manages **accounts** (add, update, set default — and
  preserves existing settings).
- `/gmail-config` manages **settings** (and preserves all accounts).
- Both keep the file at mode **0600**.
- `GMAIL_EMAIL` / `GMAIL_APP_PASSWORD` env overrides for credentials stay as
  they were (env wins over the file, only for calls without an `account`
  parameter).

## Tools

| Tool | Purpose |
| --- | --- |
| `gmail_folders` | List folders/labels with message + unread counts |
| `gmail_list` | List recent emails (newest first); optional `query` full-text search, `unreadOnly` |
| `gmail_read` | Read an email by id: headers, text body, attachment list |
| `gmail_send` | Compose a new email (to/cc/bcc, text or html) — **sends only when `allowSend` is true; otherwise saves a draft** |
| `gmail_reply` | Reply to an email by id (threads via Reply-To/Message-ID/References) — same send guard as `gmail_send` |
| `gmail_draft` | Save a draft to the Drafts folder (never sends); optionally replace an existing draft |
| `gmail_mark` | Mark read/unread/starred/unstarred |
| `gmail_move` | Move to another folder/label (e.g. `trash`, `spam`, custom label) |
| `gmail_save_attachment` | Download an attachment to a local file (max 100 MB) |

All tools accept the optional `account` parameter (see [Multi-account](#multi-account)).

Folder aliases: `inbox`, `sent`, `starred`, `drafts`, `spam`, `trash`,
`important`, `all` — or pass an exact label/folder name.

## Commands

- `/gmail-auth` — manage accounts (add a new one, update an existing one,
  set the default) and test the connection
- `/gmail-status` — show all accounts + settings and test the IMAP
  connection of each account
- `/gmail-config` — show settings and toggle `allowSend` / `confirmSends`
  (persisted to the config file, mode 0600)

## Notes

- Message ids are IMAP UIDs **per folder** — always pass the `folder` the id
  came from (gmail_list output says which mailbox it was).
- App passwords require 2-Step Verification; revoke them anytime at the URL above.
- Dependencies: `imapflow` (IMAP), `nodemailer` (SMTP + MIME), `mailparser`
  (MIME parsing). Reinstall with `npm install` in this directory.

## Installing on another machine

The repo is a standard pi package, so the easiest way is `pi install`:

```bash
# from GitHub
pi install git:github.com/breitlip/pi-gmail
pi install https://github.com/breitlip/pi-gmail   # raw URLs work too

# pin a ref (once a tag exists)
pi install git:github.com/breitlip/pi-gmail@v1.1.0

# or from a local checkout
pi install /path/to/pi-gmail
```

`pi install` clones the repo and runs `npm install` for the runtime
dependencies. The config file still defaults to
`~/.pi/agent/extensions/gmail/config.json` regardless of install location.

Alternatively, clone directly into pi's extension directory:

```bash
git clone https://github.com/breitlip/pi-gmail ~/.pi/agent/extensions/gmail
cd ~/.pi/agent/extensions/gmail && npm install
```

Then run `/gmail-auth` in pi (or set the env vars).

## Development

```bash
npm run check     # lint (biome) + typecheck (tsc) + tests (node --test)
npm test          # unit + registration + enforcement tests (no network)
npm run test:live # additionally run live IMAP tests (needs valid credentials)
npm run format    # biome --write
```

The enforcement test (`test/enforcement.test.ts`) is the key one: with a temp
config at `allowSend: false` it invokes `gmail_send`/`gmail_reply` with the
SMTP transport factory and IMAP client factory stubbed, and asserts that **no
SMTP transport is ever created** while the IMAP draft-append path is used.

For agent-oriented notes on working on this repo (invariants, gotchas, release
flow), see [AGENTS.md](AGENTS.md).
