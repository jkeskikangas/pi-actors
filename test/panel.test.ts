import assert from "node:assert/strict";
import { test } from "node:test";
import type { Snapshot } from "../src/client/connection.ts";
import { endedRoots, initialState, items, type PanelKey, type PanelState, press, shortModel, statusLabel, summary, view, withSnapshot } from "../src/client/panel.ts";

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
	const text = view(st, 200, 30, () => []).body.map((l) => l.text).join("\n");
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

test("a transcript fills the height, follows the end, scrolls, and stays put while output grows", () => {
	const all = Array.from({ length: 20 }, (_, i) => `line ${i}`);
	const st = { ...initialState(snap([agent("root", null as never), agent("fe", "root")])), viewing: "fe" };
	const end = view(st, 40, 5, () => [...all, "", ""]);
	assert.deepEqual(end.body.map((l) => l.text), ["line 15", "line 16", "line 17", "line 18", "line 19"], "trailing blank lines are dropped");
	assert.match(end.head.text, /fe {2}running/);
	assert.match(view(st, 120, 5, () => all).foot.text, /e expand · esc back$/);
	const up = view({ ...st, scroll: 1_000 }, 40, 5, () => all);
	assert.equal(up.scroll, 15, "scroll is clamped to the transcript");
	assert.match(up.foot.text, /15 more lines/);
	const at = view({ ...st, scroll: 2 }, 40, 5, () => all);
	const after = view({ ...st, scroll: at.scroll, seen: at.seen }, 40, 5, () => [...all, "NEWER"]);
	assert.deepEqual(after.body, at.body);
	const short = view(st, 40, 5, () => ["only"]);
	assert.equal(short.body.length, 5, "a short transcript is padded to the height");
	assert.equal(view(st, 40, 5, () => []).body[0].text, " (nothing yet)");
});
