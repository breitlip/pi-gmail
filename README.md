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

## Tools

| Tool | Purpose |
| --- | --- |
| `gmail_folders` | List folders/labels with message + unread counts |
| `gmail_list` | List recent emails (newest first); optional `query` full-text search, `unreadOnly` |
| `gmail_read` | Read an email by id: headers, text body, attachment list |
| `gmail_send` | Send a new email (to/cc/bcc, text or html) |
| `gmail_reply` | Reply to an email by id (threads via Reply-To/Message-ID/References) |
| `gmail_draft` | Save a draft to the Drafts folder (not sent); optionally replace an existing draft |
| `gmail_mark` | Mark read/unread/starred/unstarred |
| `gmail_move` | Move to another folder/label (e.g. `trash`, `spam`, custom label) |
| `gmail_save_attachment` | Download an attachment to a local file (max 100 MB) |

Folder aliases: `inbox`, `sent`, `starred`, `drafts`, `spam`, `trash`,
`important`, `all` — or pass an exact label/folder name.

## Installing on another machine

```bash
git clone https://github.com/breitlip/pi-gmail ~/.pi/agent/extensions/gmail
cd ~/.pi/agent/extensions/gmail && npm install
```

Then run `/gmail-auth` in pi (or set the env vars).

## Commands

- `/gmail-auth` — configure credentials and test the connection
- `/gmail-status` — show configured account and test the connection

## Notes

- Message ids are IMAP UIDs **per folder** — always pass the `folder` the id
  came from (gmail_list output says which mailbox it was).
- App passwords require 2-Step Verification; revoke them anytime at the URL above.
- Dependencies: `imapflow` (IMAP), `nodemailer` (SMTP), `mailparser` (MIME parsing).
  Reinstall with `npm install` in this directory.
