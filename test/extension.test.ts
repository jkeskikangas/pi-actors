// src/index.ts against a fake pi host and a real broker with fake child agents (no model).
// Each test pins a finding from the code reviews (F*: 2026-10-05, N*: 2026-10-06).

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
	await h.waitFor(() => /echo:echo/.test(h.inbox()) && (h.inbox().match(/has ended: normal/g) ?? []).length === 2);
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
	await h.waitFor(() => /w has ended/.test(h.inbox()));
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
	await h.waitFor(() => /again has ended: normal/.test(h.inbox()));
});

test("F11: a root session switch keeps the tree (children's reports reach the new session)", async () => {
	const sessionA = root();
	await sessionA.tool("spawn", { task: "serve", name: "keep" });
	await sessionA.fire("session_shutdown", { reason: "new" });
	// pi replaces the extension runtime in the same process; the new session has no tree entry.
	const sessionB = root({}, true);
	await sessionB.fire("session_start", { reason: "new" });
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

test("N5: /answer <#> addresses the question /inbox showed, never whatever moved into that position", async () => {
	const h = root();
	await h.tool("spawn", { task: "ask first?", name: "qa" });
	await h.tool("spawn", { task: "ask second?", name: "qb" });
	for (;;) {
		await h.command("inbox");
		if ((lastNote(h).match(/^#\d+ /gm) ?? []).length === 2) break;
		await new Promise((r) => setTimeout(r, 100));
	}
	const listed = [...lastNote(h).matchAll(/^#(\d+) \[(\S+)\] from ([^\s:]+)/gm)].map((m) => ({ n: m[1], ref: m[2], from: m[3] }));
	await h.command("answer", `${listed[0].ref} by id`);
	await h.waitFor(() => new RegExp(`got:.*by id`).test(h.inbox()));
	await h.command("answer", "1 stale position");
	assert.match(lastNote(h), /no longer open/);
	await h.command("answer", "2 the second");
	await h.waitFor(() => /got:.*the second/.test(h.inbox()));
	assert.doesNotMatch(h.inbox(), /stale position/);
	assert.match(lastNote(h), new RegExp(`Answered #2 \\(${listed[1].from}\\)`));
});

test("N6: in herdr, the waiting mark and the widget clear when the tree stops and on shutdown", async () => {
	const saved = { TMUX: process.env.TMUX, HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID };
	delete process.env.TMUX;
	process.env.HERDR_ENV = "1";
	process.env.HERDR_PANE_ID = "p-test";
	try {
		const h = root({ mode: "tui" });
		const blocked = () => h.events.filter((e) => e.name === "herdr:blocked").at(-1)?.data.active;
		await h.fire("session_start", { reason: "startup" });
		await h.tool("spawn", { task: "ask which?", name: "asker" });
		await h.waitFor(() => blocked() === true && /question/.test(h.widgets["pi-actors"]?.[0] ?? ""));
		await h.command("actors", "stop");
		await h.waitFor(() => blocked() === false && h.widgets["pi-actors"] === undefined);
		await h.tool("spawn", { task: "ask again?", name: "asker2" });
		await h.waitFor(() => blocked() === true);
		await h.fire("session_shutdown", { reason: "reload" });
		assert.equal(blocked(), false, "a reload never leaves the pane marked");
	} finally {
		for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
	}
});
