// Keepers and children relaunch a dead broker, and outlive one that cannot be relaunched for the
// tree's broker-down window instead of the 60 s grace (incident 2026-11-10: the broker was down
// for 23 minutes and every child was killed after 60 s). Stop semantics are unchanged.

import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "../src/client/connection.ts";
import { ensureBroker } from "../src/client/launcher.ts";
import type { Message } from "../src/protocol.ts";
import { treeDir } from "../src/runtime.ts";

const home = mkdtempSync("/tmp/pia-relaunch-");
const fake = fileURLToPath(new URL("./fixtures/fake-agent.ts", import.meta.url));
let treeN = 0;

before(() => {
	process.env.PI_ACTORS_HOME = home;
	process.env.PI_ACTORS_SOCKET_DIR = join(home, "s");
});
const clients: Client[] = [];
after(async () => {
	for (const c of clients) c.close();
	try {
		execSync(`pkill -f ${JSON.stringify(home)}`);
	} catch {
		// nothing left
	}
	await new Promise((r) => setTimeout(r, 300));
	rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 20_000) {
	const end = Date.now() + ms;
	while (!(await ok())) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await sleep(200);
	}
}
/** Pids whose command line matches (no shell, so nothing but the processes themselves matches). */
const pgrep = (pattern: string): string[] => {
	try {
		return execFileSync("pgrep", ["-f", "--", pattern]).toString().trim().split("\n").filter(Boolean);
	} catch {
		return [];
	}
};
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
/** The child process itself (not its Keeper): its argv names the tree and its id. */
const childRuns = (treeId: string, id: string) => pgrep(`actors-tree=${treeId} .*actors-id=${id}( |$)`).length > 0;
const keeperRuns = (treeId: string, id: string) => pgrep(`keeper/main.ts ${treeDir(treeId)}/agents/${id}\\.`).length > 0;
const canConnect = (sock: string) =>
	new Promise<boolean>((res) => {
		const s = connect(sock);
		s.once("connect", () => (s.destroy(), res(true)));
		s.once("error", () => res(false));
	});
const brokerPid = (treeId: string) => (JSON.parse(readFileSync(join(treeDir(treeId), "broker.lock"), "utf8")) as { pid: number }).pid;
const keeperLog = (treeId: string, id: string) => readFileSync(join(treeDir(treeId), "agents", `${id}.1.keeper.log`), "utf8");

async function tree(brokerDownMs?: number) {
	const treeId = `k${++treeN}${process.pid % 1000}`;
	const socket = await ensureBroker({ treeId, rootCwd: home, childCommand: [process.execPath, fake], brokerDownMs });
	// No redial: only Keepers and children may bring the broker back in these tests.
	const root = new Client({ socket, id: "root", inc: 1, pid: process.pid, sessionId: "S" }, 10 * 60_000);
	clients.push(root);
	await root.start();
	return { treeId, socket, root };
}

async function receive(c: Client, filter: Parameters<Client["fetch"]>[0], ms = 20_000): Promise<Message> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const m = await c.fetch(filter);
		if (m) {
			c.ack(m.id);
			return m;
		}
		await c.waitForMail(200);
	}
	throw new Error(`no message matching ${JSON.stringify(filter)}`);
}

async function serve(root: Client) {
	const r = (await root.op("spawn", { req: { task: "serve", context: "fresh", placement: "headless" } })) as { ok: boolean; id: string };
	assert.equal(r.ok, true);
	await ask(root, r.id, "hi");
	return r.id;
}

async function ask(root: Client, id: string, body: string) {
	const sent = (await root.op("send", { to: id, kind: "mail", body })) as { ok: boolean; msgId: string };
	assert.equal(sent.ok, true, JSON.stringify(sent));
	assert.equal((await receive(root, { ref: sent.msgId })).body, `echo:${body}`);
}

/** The incident: the broker dies and its config is unusable, so nobody can relaunch it. */
function loseConfig(treeId: string) {
	const p = join(treeDir(treeId), "config.json");
	renameSync(p, `${p}.away`);
	renameSync(`${p}.bak`, `${p}.bak.away`);
}
function restoreConfig(treeId: string) {
	const p = join(treeDir(treeId), "config.json");
	renameSync(`${p}.away`, p);
	renameSync(`${p}.bak.away`, `${p}.bak`);
}

async function killBroker(treeId: string) {
	const pid = brokerPid(treeId);
	process.kill(pid, "SIGKILL");
	await until("the broker to die", () => !alive(pid));
}

test("a broker down past the 60 s grace that cannot be relaunched: children survive, and reattach once it can be", { timeout: 240_000 }, async () => {
	const { treeId, socket, root } = await tree();
	const a = await serve(root);
	const b = await serve(root);
	loseConfig(treeId);
	await killBroker(treeId);
	await sleep(75_000); // past TIMING.childGraceMs (60 s): 0.2.9 killed every child here
	assert.equal(await canConnect(socket), false, "nobody could relaunch the broker");
	for (const id of [a, b]) {
		assert.ok(childRuns(treeId, id), `${id} still runs`);
		assert.ok(keeperRuns(treeId, id), `${id}'s Keeper still runs`);
		assert.match(keeperLog(treeId, id), /broker relaunch failed: cannot relaunch the broker: .*config\.json is missing and has no usable backup; keeping the child/);
	}
	restoreConfig(treeId);
	// A Keeper or a child relaunches it; the root (no redial of its own) reconnects.
	await new Promise<void>((res) => root.once("welcome", () => res()));
	for (const id of [a, b]) await ask(root, id, `after-${id}`);
	await until("a Keeper to see the broker back", () => [a, b].some((id) => /broker back after \d+ s/.test(keeperLog(treeId, id))));
	const snap = await root.inspect();
	for (const id of [a, b]) assert.equal(snap?.agents.find((x) => x.id === id)?.status, "live");
	root.stopTree();
	await until("the children to end with the tree", () => ![a, b].some((id) => childRuns(treeId, id) || keeperRuns(treeId, id)));
	root.close();
});

test("the broker-down window is bounded: past it the child ends (link rule), and says why", { timeout: 60_000 }, async () => {
	const { treeId, root } = await tree(4000);
	const a = await serve(root);
	loseConfig(treeId);
	await killBroker(treeId);
	await until("the child to end", () => !childRuns(treeId, a) && !keeperRuns(treeId, a), 30_000);
	assert.match(keeperLog(treeId, a), /broker unreachable for \d+ s: ending the child \(link rule\)|broker relaunch failed/);
	restoreConfig(treeId);
	root.close();
});

test("stop still ends a child at once; stop_tree ends every child and no Keeper relaunches the finished tree", { timeout: 60_000 }, async () => {
	const { treeId, socket, root } = await tree();
	const a = await serve(root);
	const b = await serve(root);
	const t0 = Date.now();
	assert.equal((await root.op("kill", { target: a })).ok, true);
	assert.match(JSON.parse((await receive(root, { kind: "down" })).body).reason, /^killed/);
	await until("the stopped child to be gone", () => !childRuns(treeId, a) && !keeperRuns(treeId, a), 15_000);
	assert.ok(Date.now() - t0 < 15_000, "promptly, not after a grace period");
	const t1 = Date.now();
	root.stopTree();
	await until("the tree's children to be gone", () => !childRuns(treeId, b) && !keeperRuns(treeId, b), 15_000);
	assert.ok(Date.now() - t1 < 15_000);
	await until("the broker to exit", async () => !(await canConnect(socket)));
	await sleep(5000);
	assert.equal(await canConnect(socket), false, "a finished tree is not relaunched");
	assert.equal(JSON.parse(readFileSync(join(treeDir(treeId), "status.json"), "utf8")).finished, true);
	root.close();
});

test("many Keepers and children racing to relaunch start one broker", { timeout: 60_000 }, async () => {
	const { treeId, root } = await tree();
	const ids = [await serve(root), await serve(root), await serve(root)];
	const before = brokerPid(treeId);
	const welcomed = new Promise<void>((res) => root.once("welcome", () => res()));
	process.kill(before, "SIGKILL");
	await welcomed;
	for (const id of ids) await ask(root, id, `again-${id}`);
	await sleep(2000); // brokers that lost the lock race exit at once
	const brokers = pgrep(`broker/main.ts ${treeDir(treeId)} `);
	assert.deepEqual(brokers, [String(brokerPid(treeId))], "one broker, the lock holder");
	assert.notEqual(brokerPid(treeId), before);
	root.stopTree();
	root.close();
});
