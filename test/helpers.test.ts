import assert from "node:assert/strict";
import { test } from "node:test";
import type { MessageStructureObject } from "imapflow";
import {
  findAttachmentPart,
  formatAddress,
  formatAddresses,
  resolveFolder,
  toAddressList,
  toTextList,
  truncate,
} from "../index.ts";

test("resolveFolder maps aliases", () => {
  assert.equal(resolveFolder(), "INBOX");
  assert.equal(resolveFolder("inbox"), "INBOX");
  assert.equal(resolveFolder("sent"), "[Gmail]/Sent Mail");
  assert.equal(resolveFolder("sent mail"), "[Gmail]/Sent Mail");
  assert.equal(resolveFolder("drafts"), "[Gmail]/Drafts");
  assert.equal(resolveFolder("starred"), "[Gmail]/Starred");
  assert.equal(resolveFolder("spam"), "[Gmail]/Spam");
  assert.equal(resolveFolder("trash"), "[Gmail]/Trash");
  assert.equal(resolveFolder("important"), "[Gmail]/Important");
  assert.equal(resolveFolder("all"), "[Gmail]/All Mail");
  assert.equal(resolveFolder("all mail"), "[Gmail]/All Mail");
});

test("resolveFolder passes unknown folders through (trimmed)", () => {
  assert.equal(resolveFolder("  My Custom Label  "), "My Custom Label");
  assert.equal(resolveFolder("[Gmail]/Something"), "[Gmail]/Something");
});

test("toTextList normalizes strings, arrays, and empties", () => {
  assert.equal(toTextList(undefined), undefined);
  assert.equal(toTextList(""), undefined);
  assert.deepEqual(toTextList("  a@b.c  "), ["a@b.c"]);
  assert.deepEqual(toTextList([" a@b.c ", "", "c@d.e"]), ["a@b.c", "c@d.e"]);
  assert.equal(toTextList(["", "  "]), undefined);
});

test("truncate leaves short text alone and marks long text", () => {
  assert.equal(truncate("hello", 10), "hello");
  assert.equal(truncate("hello world", 5), "hello\n… [truncated at 5 chars]");
  const long = "x".repeat(1000);
  const out = truncate(long, 100);
  assert.ok(out.startsWith("x".repeat(100)));
  assert.ok(out.includes("[truncated at 100 chars]"));
});

test("formatAddress handles name, address, and missing", () => {
  assert.equal(formatAddress(), "unknown");
  assert.equal(formatAddress({ address: "a@b.c" }), "a@b.c");
  assert.equal(formatAddress({ name: "A B", address: "a@b.c" }), "A B <a@b.c>");
  assert.equal(formatAddress({ name: "A B" }), "unknown");
});

test("formatAddresses joins with commas", () => {
  assert.equal(formatAddresses(), "");
  assert.equal(formatAddresses(undefined), "");
  assert.equal(formatAddresses([]), "");
  assert.equal(formatAddresses([{ name: "A", address: "a@b.c" }, { address: "c@d.e" }]), "A <a@b.c>, c@d.e");
});

test("toAddressList normalizes mailparser v3 address objects", () => {
  // mailparser v3 shape: { value: [...], html, text }
  const mailparserShape = {
    value: [
      { address: "alice@example.com", name: "Alice" },
      { address: "bob@example.com", name: "" },
    ],
    html: "<html>",
    text: "Alice <alice@example.com>, bob@example.com",
  };
  assert.deepEqual(toAddressList(mailparserShape), [
    { name: "Alice", address: "alice@example.com" },
    { name: "", address: "bob@example.com" },
  ]);

  // plain address, plain string, arrays, and empties
  assert.deepEqual(toAddressList({ name: "A", address: "a@b.c" }), [{ name: "A", address: "a@b.c" }]);
  assert.deepEqual(toAddressList("  a@b.c"), [{ address: "a@b.c" }]);
  assert.deepEqual(toAddressList(["a@b.c", "c@d.e"]), [{ address: "a@b.c" }, { address: "c@d.e" }]);
  assert.equal(toAddressList(undefined), undefined);
  assert.equal(toAddressList(""), undefined);
  assert.equal(toAddressList({ value: [] }), undefined);
  assert.equal(toAddressList({ value: [{ name: "no address" }] }), undefined);
});

test("findAttachmentPart finds nested attachments case-insensitively", () => {
  const tree: MessageStructureObject = {
    type: "multipart/mixed",
    childNodes: [
      { type: "text/plain", disposition: "inline" },
      {
        type: "multipart/alternative",
        childNodes: [
          { type: "text/html" },
          {
            type: "application/pdf",
            disposition: "attachment",
            dispositionParameters: { filename: "Report.PDF" },
            part: "2.2",
          },
        ],
      },
    ],
  };
  const found = findAttachmentPart(tree, "report.pdf");
  assert.deepEqual(found, { key: "2.2", contentType: "application/pdf" });
  assert.equal(findAttachmentPart(tree, "missing.pdf"), null);

  // disposition without dispositionParameters (filename in the disposition string)
  const tree2: MessageStructureObject = {
    type: "application/octet-stream",
    disposition: 'attachment; filename="notes.txt"',
    part: "3",
  };
  assert.deepEqual(findAttachmentPart(tree2, "NOTES.TXT"), { key: "3", contentType: "application/octet-stream" });
});
