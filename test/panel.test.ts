import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Snapshot } from "../src/client/connection.ts";
import { DECLINED, encodeQuestion, formatAnswer, itemsFrom, parseQuestion, press, readTranscript, render, summary } from "../src/client/panel.ts";

const agent = (id: string, parent: string, status = "live", extra = {}) => ({ id, parent, status, inc: 1, connected: true, mailbox: 0, spawns: 0, ...extra });
const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
	treeId: "t", self: "root", pendingCalls: [], liveChildren: 0,
	agents: [agent("root", null as never), agent("fe", "root"), agent("fe.rev", "fe", "down", { reason: "normal" }), agent("be", "root", "live", { placement: "pane" })],
	human: [{ ref: "fe:1:3", from: "fe", body: "Use REST or GraphQL?" }],
	...over,
});

test("questions come first, then the tree in parent order without the root", () => {
	const items = itemsFrom(snap());
	assert.deepEqual(items.map((i) => (i.kind === "question" ? `?${i.from}` : `${i.id}@${i.depth}`)), ["?fe", "fe@0", "fe.rev@1", "be@0"]);
});

test("summary line appears only when something needs attention", () => {
	assert.equal(summary(snap()), "pi-actors · 2 agents · 1 question for you — ↓ to open");
	assert.equal(summary(snap({ human: [], agents: [agent("root", null as never), agent("x", "root", "down")] })), undefined);
	assert.equal(summary(undefined), undefined);
});

test("navigation wraps; enter answers a question or opens a transcript; esc backs out, then closes", () => {
	let st = { items: itemsFrom(snap()), selected: 0 };
	const opened = press(st, "enter");
	assert.equal(opened.action.type, "none");
	assert.equal(opened.state.card?.ref, "fe:1:3", "enter on a question opens its card");
	st = press(st, "up").state;
	assert.equal(st.selected, 3, "wraps to the last item");
	assert.equal(press(st, "focus").action.type, "focusPane", "be runs in a pane");
	const viewing = press({ ...st, selected: 1 }, "enter").state;
	assert.equal(viewing.viewing, "fe");
	assert.equal(press(viewing, "escape").state.viewing, undefined);
	assert.deepEqual(press(st, "escape").action, { type: "close" });
	assert.equal(press({ ...st, selected: 1 }, "focus").action.type, "none", "headless agents have no pane");
});

test("rendering marks the selection and hides the pane hint without panes", () => {
	const lines = render({ items: itemsFrom(snap()), selected: 0 }, () => []);
	assert.match(lines[0], /f focus pane/);
	assert.match(lines[1], /^❯ \? fe asks: Use REST or GraphQL\?/);
	assert.match(lines[3], /^ {4}fe\.rev · down \(normal\)/);
	const noPanes = render({ items: itemsFrom(snap({ agents: [agent("root", null as never), agent("fe", "root")] })), selected: 0 }, () => []);
	assert.doesNotMatch(noPanes[0], /focus pane/);
});

test("transcript shows the task, tool calls, answers and pushed updates from the session file", () => {
	const f = join(mkdtempSync(join(tmpdir(), "pia-tr-")), "s.jsonl");
	const lines = [
		{ type: "session" },
		{ type: "custom_message", customType: "pi-actors", content: "[pi-actors] 1 update for fe:\n■ Task from root: build it" },
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash" }, { type: "text", text: "Running tests" }] } },
		{ type: "message", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "ok" }] } },
	];
	writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n"));
	const t = readTranscript(f);
	assert.ok(t[0].startsWith("⇢ [pi-actors]"));
	assert.deepEqual(t.slice(1), ["  ⚙ bash", "assistant: Running tests", "  ↳ bash: ok"]);
	assert.deepEqual(readTranscript(undefined), ["(no session file yet)"]);
});

const withQuestion = (body: string) => ({ items: itemsFrom(snap({ human: [{ ref: "r1", from: "fe", body }] })), selected: 0 });
const keys = (st: any, ...ks: any[]) => {
	let r: any = { state: st, action: { type: "none" } };
	for (const k of ks) r = press(r.state, k);
	return r;
};

test("questions round-trip: plain text stays plain; choices are structured", () => {
	assert.equal(encodeQuestion("Ship it?"), "Ship it?");
	assert.deepEqual(parseQuestion(encodeQuestion("API?", ["REST", { label: "GraphQL", description: "one endpoint" }], false)), {
		text: "API?", choices: [{ label: "REST" }, { label: "GraphQL", description: "one endpoint" }], multi: false,
	});
	assert.deepEqual(parseQuestion("not json {"), { text: "not json {", choices: [], multi: false });
});

test("single choice: arrows pick, enter answers with the label, linked to the question", () => {
	const r = keys(withQuestion(encodeQuestion("API?", ["REST", "GraphQL"])), "enter", "down", "enter");
	assert.deepEqual(r.action, { type: "answer", ref: "r1", from: "fe", body: "Chose: GraphQL" });
});

test("multi-select: space toggles, enter confirms all picked", () => {
	const r = keys(withQuestion(encodeQuestion("Targets?", ["web", "ios", "android"], true)), "enter", "space", "down", "down", "space", "enter");
	assert.deepEqual(r.action, { type: "answer", ref: "r1", from: "fe", body: "Selected: web, android" });
	const lines = render(keys(withQuestion(encodeQuestion("Targets?", ["web", "ios"], true)), "enter", "space").state, () => []);
	assert.ok(lines.some((l) => l.includes("[x] web")) && lines.some((l) => l.includes("[ ] ios")));
});

test("free text: the last row asks for text (with any picks kept); plain questions go straight to it", () => {
	const r = keys(withQuestion(encodeQuestion("API?", ["REST", "GraphQL"])), "enter", "up", "enter");
	assert.equal(r.action.type, "freeText");
	assert.equal(formatAnswer(r.action.q, [], "gRPC actually"), "gRPC actually");
	assert.equal(formatAnswer(parseQuestion(encodeQuestion("x", ["a"], true)), ["a"], "and b"), "Selected: a\nNote: and b");
	assert.equal(keys(withQuestion("Free question?"), "enter", "enter").action.type, "freeText");
});

test("decline, transcript and back from the card", () => {
	assert.deepEqual(keys(withQuestion("Q?"), "enter", "decline").action, { type: "answer", ref: "r1", from: "fe", body: DECLINED });
	const viewing = keys(withQuestion("Q?"), "enter", "transcript").state;
	assert.equal(viewing.viewing, "fe", "transcript of the asker");
	const back = keys(viewing, "escape").state;
	assert.ok(back.card && !back.viewing, "esc returns to the card");
	assert.equal(keys(back, "escape").state.card, undefined, "esc again returns to the list");
});
