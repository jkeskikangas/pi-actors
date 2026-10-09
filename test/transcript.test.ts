import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { readSession, Transcript } from "../src/client/transcript.ts";

initTheme("dark");
// biome-ignore lint: control characters are the point
const plain = (lines: string[]) => lines.map((l) => l.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").trimEnd());
const fakeTui = { requestRender() {} } as never;

const sessionFile = (lines: unknown[]) => {
	const f = join(mkdtempSync(join(tmpdir(), "pia-tr-")), "s.jsonl");
	writeFileSync(f, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	return f;
};

test("the session file is read incrementally; a replaced file is read again", () => {
	const f = sessionFile([{ type: "session", cwd: "/w" }]);
	assert.equal(readSession(f).length, 1);
	appendFileSync(f, `${JSON.stringify({ type: "message", message: { role: "user", content: "hi" } })}\n{"partial`);
	assert.equal(readSession(f).length, 2, "a partial last line waits for its newline");
	writeFileSync(`${f}.new`, `${JSON.stringify({ type: "message", message: { role: "user", content: "fresh" } })}\n`);
	renameSync(`${f}.new`, f);
	assert.deepEqual(readSession(f), [{ type: "message", message: { role: "user", content: "fresh" } }]);
	assert.deepEqual(readSession(undefined), []);
});

test("a transcript renders like the main session: markdown, compact tool rows, the delivery line; e expands", () => {
	const task = { id: "m1", from: "root", to: "fe", kind: "mail", tag: "task", body: "build it" };
	const f = sessionFile([
		{ type: "session", cwd: "/w" },
		{ type: "custom_message", customType: "pi-actors", content: "■ Task from root (msg m1):\nbuild it", display: true, details: { actors: { messages: [task] } } },
		{ type: "message", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "1. **Bold** and `code`" }, { type: "toolCall", id: "t1", name: "bash", arguments: { command: "git diff --stat" } }] } },
		{ type: "message", message: { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "a\nSECOND" }], isError: false } },
	]);
	const t = new Transcript(fakeTui, "/", { outputPad: 1, hideThinkingBlock: true });
	t.sync(readSession(f));
	const collapsed = plain(t.render(60)).join("\n");
	assert.match(collapsed, /⇢ task from root/);
	assert.match(collapsed, /1\. Bold and code/, "markdown is rendered, not shown raw");
	assert.match(collapsed, /bash git diff --stat/);
	assert.doesNotMatch(collapsed, /SECOND/, "collapsed tool rows hide output");
	t.setExpanded(true);
	const expanded = plain(t.render(60)).join("\n");
	assert.match(expanded, /SECOND/);
	assert.match(expanded, /build it/);

	// New lines extend the transcript; a result reaches its call.
	appendFileSync(f, `${JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "LAST" }] } })}\n`);
	t.sync(readSession(f));
	assert.match(plain(t.render(60)).join("\n"), /LAST\s*$/);
});
