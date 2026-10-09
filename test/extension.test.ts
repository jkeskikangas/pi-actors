// src/index.ts against a fake pi host and a real broker with fake child agents (no model).
// Each test pins a finding from the code reviews (F*: 2026-10-05, N*: 2026-10-06).

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { fakeHost } from "./fixtures/host.ts";

const home = mkdtempSync("/tmp/pia-ext-");
const fake = fileURLToPath(new URL("./fixtures/fake-agent.ts", import.meta.url));
let n = 0;
const hosts: ReturnType<typeof fakeHost>[] = [];

before(() => {
	process.env.PI_ACTORS_HOME = join(home, "h");
	process.env.PI_ACTORS_SOCKET_DIR = join(home, "s");
	process.env.PI_ACTORS_CHILD_COMMAND = JSON.stringify([process.execPath, fake]);
});
after(async () => {
	for (const h of hosts) await h.fire("session_shutdown", { reason: "quit" });
	try {
		execSync(`pkill -f ${JSON.stringify(home)}`);
	} catch {}
	// Killed brokers may still be writing their last status file: retry the removal.
	await new Promise((r) => setTimeout(r, 300));
	rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function root(extra: Partial<Parameters<typeof fakeHost>[0]> = {}, keepCarry = false) {
	// One pi process has one root at a time; tests run several, so forget the carried tree.
	if (!keepCarry) rmSync(join(home, "h", "roots"), { recursive: true, force: true });
	const h = fakeHost({ cwd: home, sessionId: `s${++n}-${process.pid}`, ...extra });
	hosts.push(h);
	return h;
}

test("F2: parallel first spawns share one connection; both return and pushes keep flowing", async () => {
	const h = root();
	const results = await Promise.race([
		Promise.all([h.tool("spawn", { task: "echo", name: "a" }), h.tool("spawn", { task: "echo", name: "b" })]),
		new Promise((_, rej) => setTimeout(() => rej(new Error("a spawn hung")), 10_000)),
	]);
	assert.equal((results as unknown[]).length, 2);
	await h.waitFor(() => /echo:echo/.test(h.inbox()) && (h.inbox().match(/ended: normal/g) ?? []).length === 2);
});

test("F1: a missing cwd is rejected by the tool; relative paths resolve against the agent's cwd", async () => {
	const h = root();
	await assert.rejects(h.tool("spawn", { task: "echo", cwd: "no/such/dir" }), /not a directory/);
	assert.match((await h.tool("spawn", { task: "echo", cwd: "." })).content[0].text, /Started/);
});

test("F4: a push that pi dropped (queue cleared) is redelivered after the agent settles", async () => {
	const h = root();
	h.setPush("drop");
	await h.tool("spawn", { task: "serve", name: "srv" });
	await h.tool("send", { to: "srv", text: "ping" });
	await h.waitFor(() => /echo:ping/.test(h.inbox()));
	const before = h.pushed.length;
	h.setPush("persist");
	await new Promise((r) => setTimeout(r, 5200)); // reclaim only what has been in flight for a while
	await h.fire("agent_settled");
	await h.waitFor(() => h.pushed.length > before && /echo:ping/.test(h.pushed.at(-1)!.content));
});

test("F8: an oversized message is refused up front and does not break later sends", async () => {
	const h = root();
	await h.tool("spawn", { task: "serve", name: "big" });
	await assert.rejects(h.tool("send", { to: "big", text: "x".repeat(70_000) }), /too large/);
	assert.match((await h.tool("send", { to: "big", text: "small" })).content[0].text, /Sent/);
	await h.waitFor(() => /echo:small/.test(h.inbox()));
});

test("F12: waiting is tracked for direct children only, and cleared when they report or end", async () => {
	const h = root();
	const waiting = () => h.events.filter((e) => e.name === "actors:waiting").at(-1)?.data.waiting;
	await h.tool("spawn", { task: "echo", name: "w" });
	assert.equal(waiting(), true);
	await h.waitFor(() => /w ended/.test(h.inbox()));
	assert.equal(waiting(), false);
	await h.tool("send", { to: "nobody-of-mine", text: "hi" }).catch(() => {});
	assert.equal(waiting(), false, "a failed or non-child send never sets waiting");
});

test("F7: after /actors stop, the next spawn starts a fresh tree instead of failing forever", async () => {
	const h = root();
	await h.tool("spawn", { task: "serve", name: "s1" });
	await h.command("actors", "stop");
	await new Promise((r) => setTimeout(r, 1500));
	assert.match((await h.tool("spawn", { task: "echo", name: "again" })).content[0].text, /Started again/);
	await h.waitFor(() => /again ended: normal/.test(h.inbox()));
});

test("F11: a root session switch (/fork) keeps the tree (children's reports reach the new session)", async () => {
	const sessionA = root();
	await sessionA.tool("spawn", { task: "serve", name: "keep" });
	await sessionA.fire("session_shutdown", { reason: "fork" });
	// pi replaces the extension runtime in the same process; the new session has no tree entry.
	const sessionB = root({}, true);
	await sessionB.fire("session_start", { reason: "fork" });
	await sessionB.tool("send", { to: "keep", text: "still there?" });
	await sessionB.waitFor(() => /echo:still there\?/.test(sessionB.inbox()));
});

const lastNote = (h: ReturnType<typeof fakeHost>) => h.notes.at(-1) ?? "";
const treeOf = (h: ReturnType<typeof fakeHost>) => h.entries.filter((e) => e.type === "custom" && e.customType === "pi-actors-root").at(-1)?.data.treeId;

test("N1: pi keeping an injection that was also redelivered does not show the model the message twice", async () => {
	const h = root();
	await h.tool("spawn", { task: "serve", name: "k" });
	h.setPush("keep");
	await h.tool("send", { to: "k", text: "once" });
	await h.waitFor(() => /echo:once/.test(h.inbox()));
	h.setPush("persist");
	await new Promise((r) => setTimeout(r, 5200));
	await h.fire("agent_settled"); // looks lost: redelivered and persisted
	await h.waitFor(() => h.entries.some((e) => e.type === "custom_message" && /echo:once/.test(e.content)));
	h.drainQueue(); // ...and then pi delivers the copy it kept
	const seen = (await h.context()).filter((m: any) => /echo:once/.test(m.content));
	assert.equal(seen.length, 1);
});

test("N4: a session switch (/resume) into a session that recorded another tree keeps the running tree", async () => {
	const other = root();
	await other.tool("spawn", { task: "echo", name: "x" });
	const otherTree = treeOf(other);
	await other.fire("session_shutdown", { reason: "quit" });
	const a = root();
	await a.tool("spawn", { task: "serve", name: "keep2" });
	await a.fire("session_shutdown", { reason: "resume" });
	const b = root({}, true);
	b.entries.push({ type: "custom", customType: "pi-actors-root", data: { treeId: otherTree } });
	await b.fire("session_start", { reason: "resume" });
	await b.tool("send", { to: "keep2", text: "here?" });
	await b.waitFor(() => /echo:here\?/.test(b.inbox()));
});

test("N8: a carry file left by an earlier process with the same pid is ignored", async () => {
	rmSync(join(home, "h", "roots"), { recursive: true, force: true });
	mkdirSync(join(home, "h", "roots"), { recursive: true });
	writeFileSync(join(home, "h", "roots", `${process.pid}.json`), JSON.stringify({ treeId: "0123456789", started: 1 }));
	const h = root({}, true);
	await h.tool("spawn", { task: "echo", name: "fresh" });
	assert.notEqual(treeOf(h), "0123456789");
});

const children = (h: ReturnType<typeof fakeHost>) => h.command("actors").then(() => lastNote(h));

test("/new stops the whole tree; the new session starts a fresh one", async () => {
	const a = root();
	await a.tool("spawn", { task: "serve", name: "old" });
	const oldTree = treeOf(a);
	await a.fire("session_shutdown", { reason: "new" });
	const b = root({}, true);
	await b.fire("session_start", { reason: "new" });
	await assert.rejects(b.tool("send", { to: "old", text: "there?" }), /unknown_target|no parent/);
	await b.tool("spawn", { task: "echo", name: "next" });
	assert.notEqual(treeOf(b), oldTree);
	assert.doesNotMatch(await children(b), /old/);
	// The old tree really stopped, rather than waiting out the root's 5-minute grace.
	const status = join(home, "h", "trees", oldTree, "status.json");
	for (let i = 0; ; i++) {
		try {
			if (JSON.parse(readFileSync(status, "utf8")).finished === true) break;
		} catch {}
		assert.ok(i < 100, "the old tree did not finish");
		await new Promise((r) => setTimeout(r, 100));
	}
});

test("stopping a child is silent; an end the agent did not cause is pushed", async () => {
	const h = root();
	await h.tool("spawn", { task: "serve", name: "quiet" });
	await h.tool("stop", { id: "quiet" });
	await h.tool("spawn", { task: "crash", name: "loud" });
	await h.waitFor(() => /loud ended: error:crashed/.test(h.inbox()));
	while (!/quiet {2}stopped/.test(await children(h))) await new Promise((r) => setTimeout(r, 200));
	assert.doesNotMatch(h.inbox(), /quiet ended/);
	assert.equal(h.events.filter((e) => e.name === "actors:waiting").at(-1)?.data.waiting, false);
});

test("/actors clear removes ended agents (and their subtrees) but leaves running ones", async () => {
	const h = root();
	await h.tool("spawn", { task: "echo", name: "done1" });
	await h.tool("spawn", { task: "serve", name: "busy" });
	await h.waitFor(() => /done1 ended: normal/.test(h.inbox()));
	await h.command("actors", "clear");
	assert.match(lastNote(h), /Cleared 1 ended subtree/);
	const tree = await children(h);
	assert.doesNotMatch(tree, /done1/);
	assert.match(tree, /busy {2}running/);
	await h.command("actors", "clear");
	assert.match(lastNote(h), /No ended agents/);
});

test("panel: kitty-encoded keys work; x on the ended row clears every ended agent while the panel stays open", async () => {
	const h = root({ mode: "tui" });
	await h.fire("session_start", { reason: "startup" });
	await h.tool("spawn", { task: "echo", name: "gone" });
	await h.tool("spawn", { task: "serve", name: "here" });
	await h.waitFor(() => /gone ended: normal/.test(h.inbox()));
	void h.command("actors");
	await h.waitFor(() => h.overlayOpen());
	assert.match(h.overlayLines().join("\n"), /▸ 1 ended/);
	h.press("down"); // to the ended row
	assert.match(h.overlayLines().join("\n"), /x clear all ended/);
	h.press("\x1b[120u"); // "x" under the kitty keyboard protocol
	await h.waitFor(() => !/ended/.test(h.overlayLines().join("\n")));
	assert.ok(h.overlayOpen(), "the panel stays open");
	assert.match(h.overlayLines().join("\n"), /here {2}running/);
	h.press("\x1b[102u"); // "f" on a headless agent explains instead of doing nothing
	assert.match(lastNote(h), /headless/);
	h.press("escape");
	assert.equal(h.overlayOpen(), false);
});

test("a delivery renders as one collapsed line; expanded shows what the model read", async () => {
	const h = root();
	await h.tool("spawn", { task: "echo", name: "r" });
	await h.waitFor(() => /r ended: normal/.test(h.inbox()));
	const p = h.pushed.find((x) => /echo:echo/.test(x.content))!;
	assert.doesNotMatch(p.content, /\[pi-actors\]|Reply with send/, "no header or footer");
	const theme = { fg: (_c: string, t: string) => t };
	const collapsed = h.renderers["pi-actors"]({ content: p.content, details: p.details }, { expanded: false, outputPad: 0 }, theme).render(200).join("\n");
	assert.match(collapsed, /⇢ message from r/);
	assert.doesNotMatch(collapsed, /echo:echo/);
	const expanded = h.renderers["pi-actors"]({ content: p.content, details: p.details }, { expanded: true, outputPad: 0 }, theme).render(200).join("\n");
	assert.match(expanded, /echo:echo/);
});

test("in tui, the widget counts running agents and clears when the tree stops", async () => {
	const h = root({ mode: "tui" });
	await h.fire("session_start", { reason: "startup" });
	await h.tool("spawn", { task: "serve", name: "w1" });
	await h.waitFor(() => /1 running/.test(h.widgets["pi-actors"]?.[0] ?? ""), 8000);
	await h.command("actors", "stop");
	await h.waitFor(() => h.widgets["pi-actors"] === undefined, 8000);
});

test("a session switch keeps the tree even when the process uptime clock jumped (system sleep)", async () => {
	const a = root();
	await a.tool("spawn", { task: "serve", name: "sleeper" });
	await a.fire("session_shutdown", { reason: "resume" });
	const uptime = process.uptime;
	process.uptime = () => uptime() - 3600; // an hour of sleep, as the monotonic clock sees it
	try {
		const b = root({}, true);
		await b.fire("session_start", { reason: "resume" });
		await b.tool("send", { to: "sleeper", text: "awake?" });
		await b.waitFor(() => /echo:awake\?/.test(b.inbox()));
	} finally {
		process.uptime = uptime;
	}
});

test("a tool call whose signal is already aborted does not start anything", async () => {
	const h = root();
	await assert.rejects(h.tools.spawn.execute("c1", { task: "echo", name: "never" }, AbortSignal.abort(), undefined, h.ctx), /abort/i);
	assert.equal(h.pushed.length, 0);
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(treeOf(h), undefined, "no tree was started or recorded");
});
