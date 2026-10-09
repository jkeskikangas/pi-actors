import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Snapshot } from "../src/client/connection.ts";
import { endedRoots, initialState, items, type PanelKey, type PanelState, press, readTranscript, shortModel, statusLabel, summary, transcriptLines, view, withSnapshot } from "../src/client/panel.ts";

const agent = (id: string, parent: string, status = "live", extra = {}) => ({ id, parent, status, inc: 1, connected: true, mailbox: 0, spawns: 0, ...extra });
const snap = (agents = [
	agent("root", null as never),
	agent("fe", "root"),
	agent("fe.rev", "fe", "down", { reason: "normal" }),
	agent("be", "root", "live", { placement: "pane", model: "claude-sdk/claude-opus-5-5" }),
	agent("old", "root", "down", { reason: "killed:unconfirmed", mailbox: 3 }),
	agent("old.kid", "old", "down", { reason: "killed:parent_down" }),
	agent("gone", "root", "down", { reason: "killed", placement: "pane" }),
]): Snapshot => ({ treeId: "t", self: "root", liveChildren: 0, agents });

const rows = (st: PanelState) => items(st).map((i) => (i.kind === "ended" ? `${i.expanded ? "▾" : "▸"}${i.count}` : `${i.id}@${i.depth}`));
const keys = (st: PanelState, ...ks: PanelKey[]) => ks.reduce((acc, k) => press(acc.state, k), { state: st, action: { type: "none" } } as ReturnType<typeof press>);

test("running agents first in tree order; ended subtrees collapse into one row that expands", () => {
	const st = initialState(snap());
	assert.deepEqual(rows(st), ["fe@0", "fe.rev@1", "be@0", "▸3"], "fe may still resume fe.rev: it stays under fe");
	assert.deepEqual(rows({ ...st, showEnded: true }), ["fe@0", "fe.rev@1", "be@0", "▾3", "old@0", "old.kid@1", "gone@0"]);
	assert.deepEqual(endedRoots(st), ["old", "gone"]);
	assert.deepEqual(keys(st, "down", "clear").action, { type: "none" }, "fe.rev is not clearable");
});

test("a pane child's panel shows and clears only its own subtree", () => {
	const s = { ...snap([agent("root", null as never), agent("x", "root", "down"), agent("me", "root"), agent("me.k", "me", "down", { reason: "normal" })]), self: "me" };
	assert.deepEqual(rows({ ...initialState(s), showEnded: true }), ["▾1", "me.k@0"]);
	assert.deepEqual(endedRoots({ snap: s }), ["me.k"]);
});

test("an ended agent with a running descendant stays in the running section and is not cleared", () => {
	const st = initialState(snap([agent("root", null as never), agent("lead", "root", "down", { reason: "killed" }), agent("lead.k", "lead", "killing")]));
	assert.deepEqual(rows(st), ["lead@0", "lead.k@1"]);
	assert.deepEqual(endedRoots(st), []);
});

test("labels read as words; models are shortened; ended agents drop pane and queue noise", () => {
	assert.equal(statusLabel("live"), "running");
	assert.equal(statusLabel("down", "killed:unconfirmed"), "stopped, exit unconfirmed");
	assert.equal(statusLabel("down", "killed:parent_down"), "stopped with its parent");
	assert.equal(statusLabel("down", "error:crashed(3)"), "crashed (3)");
	assert.equal(shortModel("claude-sdk/claude-opus-5-5"), "opus-5-5");
	const st = { ...initialState(snap()), showEnded: true };
	const text = view(st, 200, 30, () => []).lines.map((l) => l.text).join("\n");
	assert.match(text, /● be {2}running · opus-5-5 · pane/);
	assert.match(text, /○ old {2}stopped, exit unconfirmed$/m);
});

test("summary counts running agents only", () => {
	assert.equal(summary(snap()), "pi-actors · 2 running — ↓ to open");
	assert.equal(summary(snap([agent("root", null as never), agent("x", "root", "down")])), undefined);
	assert.equal(summary(undefined), undefined);
});

test("enter toggles the ended row and opens a transcript; esc backs out, then closes", () => {
	const st = initialState(snap());
	assert.equal(keys(st, "down", "down", "down", "enter").state.showEnded, true);
	const opened = keys(st, "enter").state;
	assert.equal(opened.viewing, "fe");
	assert.equal(keys(opened, "escape").state.viewing, undefined);
	assert.deepEqual(keys(st, "escape").action, { type: "close" });
});

test("x clears an ended agent or every ended subtree; it does nothing on a running agent", () => {
	const st = initialState(snap());
	assert.deepEqual(keys(st, "clear").action, { type: "none" });
	assert.deepEqual(keys(st, "down", "down", "down", "clear").action, { type: "forget", ids: ["old", "gone"] });
	const open = { ...st, showEnded: true };
	assert.deepEqual(keys(open, "down", "down", "down", "down", "clear").action, { type: "forget", ids: ["old"] });
	const viewing = keys(open, "down", "down", "down", "down", "enter").state;
	const r = press(viewing, "clear");
	assert.deepEqual(r.action, { type: "forget", ids: ["old"] });
	assert.equal(r.state.viewing, undefined, "a cleared transcript closes");
});

test("f focuses a running pane agent and explains otherwise", () => {
	const st = initialState(snap());
	assert.deepEqual(keys(st, "down", "down", "focus").action, { type: "focusPane", id: "be" });
	assert.deepEqual(keys(st, "focus").action, { type: "notice", text: "fe runs headless; there is no pane to focus." });
	assert.deepEqual(keys({ ...st, showEnded: true }, "end", "focus").action, { type: "notice", text: "gone has ended; its pane is closed." });
});

test("a new snapshot keeps the cursor on the same agent; a cleared viewed agent closes its transcript", () => {
	const st = keys(initialState(snap()), "down", "down").state; // on be
	const moved = withSnapshot(st, snap([agent("root", null as never), agent("new", "root"), agent("fe", "root"), agent("be", "root", "live", { placement: "pane" })]));
	assert.equal(rows(moved)[moved.selected], "be@0");
	assert.equal(withSnapshot({ ...st, viewing: "old" }, snap([agent("root", null as never), agent("fe", "root")])).viewing, undefined);
});

test("the transcript wraps, shows tool calls with their key argument, scrolls and follows the end", () => {
	const f = join(mkdtempSync(join(tmpdir(), "pia-tr-")), "s.jsonl");
	const task = { id: "m1", from: "root", to: "fe", kind: "mail", tag: "task", body: "build it" };
	const lines = [
		{ type: "session" },
		{ type: "custom_message", customType: "pi-actors", content: "■ Task from root (msg m1):\nbuild it", details: { actors: { messages: [task] } } },
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "git diff --stat" } }, { type: "text", text: "word ".repeat(30).trim() }] } },
		{ type: "message", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "a\nb\nc" }] } },
	];
	writeFileSync(f, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	const entries = readTranscript(f);
	const collapsed = transcriptLines(entries, 40, false).map((l) => l.text);
	assert.equal(collapsed[0], "⇢ task from root");
	assert.ok(collapsed.includes("  ⚙ bash  git diff --stat"));
	assert.ok(collapsed.includes("    ↳ 3 lines"));
	assert.ok(collapsed.filter((l) => l.startsWith("word")).length > 1, "long text wraps instead of being cut");
	const expanded = transcriptLines(entries, 40, true).map((l) => l.text);
	assert.ok(expanded.includes("      b"));
	assert.ok(expanded.includes("  build it"));

	// Appended lines are picked up incrementally.
	appendFileSync(f, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "LAST" }] } })}\n`);
	const all = readTranscript(f);
	assert.equal(all.length, entries.length + 1);

	const st = { ...initialState(snap([agent("root", null as never), agent("fe", "root", "live", { sessionFile: f })])), viewing: "fe" };
	assert.equal(view(st, 40, 5, () => all).lines.at(-1)!.text, "LAST", "follows the end");
	const up = view({ ...st, scroll: 1_000 }, 40, 5, () => all);
	assert.ok(up.scroll > 0 && up.scroll < 1_000, "scroll is clamped to the transcript");
	assert.match(up.lines.at(-1)!.text, /more lines? below/);
	assert.deepEqual(readTranscript(undefined), []);

	// Scrolled up, the view stays on the same lines while output grows.
	const at = view({ ...st, scroll: 2 }, 40, 5, () => all);
	const more = [...all, { kind: "assistant" as const, text: "NEWER" }];
	const after = view({ ...st, scroll: at.scroll, seen: at.seen }, 40, 5, () => more);
	assert.deepEqual(after.lines.slice(1, -1), at.lines.slice(1, -1));

	// A file replaced by a shorter one is read again from the start.
	writeFileSync(`${f}.new`, `${JSON.stringify({ type: "message", message: { role: "user", content: "fresh" } })}\n`);
	renameSync(`${f}.new`, f);
	assert.deepEqual(readTranscript(f), [{ kind: "user", text: "fresh" }]);
});
