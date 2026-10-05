// src/index.ts against a fake pi host and a real broker with fake child agents (no model).
// Each test pins a finding from the 2026-10-05 code review.

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
