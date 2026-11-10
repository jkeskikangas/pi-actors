// A full or failing disk (incident 2026-11-10): atomic state files, a config.json that a full disk
// truncated, a broker that keeps serving through ENOSPC, and inspect replies for large trees.
// ENOSPC is injected with PI_ACTORS_TEST_ENOSPC (src/runtime.ts injectedFault): while the named
// file exists, state writes fail after writing part of their data, as a real full disk does.

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { EventLog } from "../src/broker/log.ts";
import { Client } from "../src/client/connection.ts";
import { ensureBroker } from "../src/client/launcher.ts";
import { LIMITS } from "../src/protocol.ts";
import { type Config, loadConfig, saveConfig, treeDir, writeFileAtomicSync } from "../src/runtime.ts";
import { type Event, initial, ROOT, type TreeState } from "../src/tree.ts";

const home = mkdtempSync("/tmp/pia-res-");
const flag = join(home, "disk-full");
const fake = fileURLToPath(new URL("./fixtures/fake-agent.ts", import.meta.url));
let treeN = 0;

before(() => {
	process.env.PI_ACTORS_HOME = home;
	process.env.PI_ACTORS_SOCKET_DIR = join(home, "s");
	// Brokers inherit it; writes fail only while `flag` exists.
	process.env.PI_ACTORS_TEST_ENOSPC = flag;
});
const clients: Client[] = [];
after(async () => {
	for (const c of clients) c.close();
	try {
		execSync(`pkill -f ${JSON.stringify(home)}`);
	} catch {
		// nothing left
	}
	delete process.env.PI_ACTORS_TEST_ENOSPC;
	await new Promise((r) => setTimeout(r, 300));
	rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const diskFull = (full: boolean) => (full ? writeFileSync(flag, "") : rmSync(flag, { force: true }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (what: string, ok: () => boolean, ms = 15_000) => {
	const end = Date.now() + ms;
	while (!ok()) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await sleep(100);
	}
};
const brokerPid = (treeId: string) => (JSON.parse(readFileSync(join(treeDir(treeId), "broker.lock"), "utf8")) as { pid: number }).pid;
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const brokerLog = (treeId: string) => readFileSync(join(treeDir(treeId), "broker.log"), "utf8");

async function killBroker(treeId: string) {
	const pid = brokerPid(treeId);
	process.kill(pid, "SIGKILL");
	await until("the broker to die", () => !alive(pid));
}

function launchFor(treeId: string) {
	return { treeId, rootCwd: home, childCommand: [process.execPath, fake] };
}

async function tree(treeId = `r${++treeN}${process.pid % 1000}`, redial = true) {
	const launch = launchFor(treeId);
	const socket = await ensureBroker(launch);
	const root = new Client({ socket, id: "root", inc: 1, pid: process.pid, sessionId: "S" }, 30_000, redial ? () => ensureBroker(launch).then(() => {}) : undefined);
	clients.push(root);
	await root.start();
	return { treeId, launch, root };
}

async function receiveDown(c: Client, ms = 15_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const m = await c.fetch({ kind: "down" });
		if (m) {
			c.ack(m.id);
			return JSON.parse(m.body) as { reason: string };
		}
		await c.waitForMail(200);
	}
	throw new Error("no DOWN");
}

// ---------------------------------------------------------------- units

test("writeFileAtomicSync: a full disk leaves the old content and no temp file", () => {
	const dir = join(home, "atomic");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "config.json");
	writeFileAtomicSync(file, '{"a":1}');
	diskFull(true);
	try {
		assert.throws(() => writeFileAtomicSync(file, '{"a":2}'), { code: "ENOSPC" });
	} finally {
		diskFull(false);
	}
	assert.equal(readFileSync(file, "utf8"), '{"a":1}');
	assert.deepEqual(readdirSync(dir), ["config.json"]);
	assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("config: saved with a backup, never rewritten unchanged, an empty one is read from the backup", () => {
	const dir = join(home, "cfg");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "config.json");
	const config: Config = { treeId: "x", limits: { maxDepth: 2, maxSpawns: 50 }, rootCwd: home, piCommand: ["pi"], runtimeDir: "/r" };
	saveConfig(path, config);
	assert.deepEqual(JSON.parse(readFileSync(`${path}.bak`, "utf8")), config);
	const ino = statSync(path).ino;
	const first = loadConfig(path);
	assert.equal(first.problem, undefined);
	saveConfig(path, first.config!, first.text);
	assert.equal(statSync(path).ino, ino, "unchanged: not rewritten");
	truncateSync(path, 0); // what writeFileSync left on the full disk
	const r = loadConfig(path);
	assert.match(r.problem!, /is empty/);
	assert.equal(r.fromBackup, true);
	assert.deepEqual(r.config, config);
	rmSync(`${path}.bak`);
	assert.equal(loadConfig(path).config, undefined);
});

test("EventLog on a full disk: no throw, no torn line; held events are written in order once space returns", () => {
	const dir = join(home, "log");
	mkdirSync(dir, { recursive: true });
	const { log } = EventLog.open(dir, "t");
	const reports: string[] = [];
	log.report = (m) => reports.push(m);
	const ev = (seq: number): Event => ({ type: "send", now: 0, from: "root", seq, to: "a", kind: "mail", body: `m${seq}` });
	log.append(ev(1), 1);
	diskFull(true);
	try {
		log.append(ev(2), 2);
		log.append(ev(3), 3, false);
		assert.match(log.failing!, /ENOSPC/);
		assert.equal(log.flush(), false);
		// Only whole lines on disk: the partial writes were cut back.
		assert.equal(EventLog.read(log.path, "t").events.length, 1);
		assert.ok(readFileSync(log.path, "utf8").endsWith("\n"));
	} finally {
		diskFull(false);
	}
	log.append(ev(4), 4);
	assert.equal(log.failing, undefined);
	assert.equal(reports.length, 2, `reported once failing, once recovered: ${reports.join(" / ")}`);
	log.close();
	const again = EventLog.open(dir, "t");
	assert.deepEqual(again.loaded.events.map((e) => (e as { seq: number }).seq), [1, 2, 3, 4]);
	again.log.close();
});

test("EventLog compaction on a full disk keeps the old log and does not throw", () => {
	const dir = join(home, "log2");
	mkdirSync(dir, { recursive: true });
	const { log } = EventLog.open(dir, "t");
	log.report = () => {};
	log.append({ type: "tick", now: 1 }, 1);
	const before = readFileSync(log.path, "utf8");
	diskFull(true);
	try {
		assert.equal(log.compact(initial("t"), 2), false);
	} finally {
		diskFull(false);
	}
	assert.equal(readFileSync(log.path, "utf8"), before);
	assert.equal(log.compact(initial("t"), 3), true);
	log.close();
});

// ---------------------------------------------------------------- broker and launcher

test("an empty config.json (a full disk truncated it) is restored from its backup; the broker starts", async () => {
	const { treeId, launch, root } = await tree(undefined, false);
	const path = join(treeDir(treeId), "config.json");
	const original = readFileSync(path, "utf8");
	assert.equal(readFileSync(`${path}.bak`, "utf8"), original);
	root.close();
	await killBroker(treeId);
	truncateSync(path, 0);
	await ensureBroker(launch);
	assert.equal(readFileSync(path, "utf8"), original);
	assert.match(brokerLog(treeId), /config\.json is empty; restored it from .*config\.json\.bak/);
	// With no backup either: re-derived from the tree's children, logged, and the broker starts.
	await killBroker(treeId);
	truncateSync(path, 0);
	rmSync(`${path}.bak`);
	await ensureBroker(launch);
	assert.equal((JSON.parse(readFileSync(path, "utf8")) as Config).treeId, treeId);
	assert.match(brokerLog(treeId), /config\.json is empty and has no usable backup; re-derived it/);
	await killBroker(treeId);
});

test("config.json is not rewritten on a relaunch that changes nothing", async () => {
	const { treeId, launch, root } = await tree(undefined, false);
	const path = join(treeDir(treeId), "config.json");
	const ino = statSync(path).ino;
	root.close();
	await killBroker(treeId);
	await ensureBroker(launch);
	assert.equal(statSync(path).ino, ino);
	await killBroker(treeId);
});

test("a relaunch on a full disk keeps config.json whole and still starts the broker", async () => {
	const { treeId, launch, root } = await tree(undefined, false);
	const path = join(treeDir(treeId), "config.json");
	const original = readFileSync(path, "utf8");
	root.close();
	await killBroker(treeId);
	diskFull(true);
	try {
		// A changed root cwd needs a write, which the disk refuses.
		await ensureBroker({ ...launch, rootCwd: join(home, "elsewhere") });
	} finally {
		diskFull(false);
	}
	assert.equal(readFileSync(path, "utf8"), original);
	assert.match(brokerLog(treeId), /could not update .*config\.json \(ENOSPC/);
	await killBroker(treeId);
});

test("a full disk does not kill the broker: it keeps serving, holds its events and writes them once space returns", async () => {
	const { treeId, root } = await tree();
	const dir = treeDir(treeId);
	const pid = brokerPid(treeId);
	diskFull(true);
	let childId: string;
	try {
		// The child's Keeper spec cannot be written either: the child fails to start, the broker lives.
		const r = await root.op("spawn", { req: { task: "serve", context: "fresh", placement: "headless" } });
		assert.equal(r.ok, true, JSON.stringify(r));
		childId = (r as { id: string }).id;
		assert.equal((await receiveDown(root)).reason, "error:start_failed");
		assert.ok(await root.inspect(), "inspect answered");
		await sleep(2500); // status writes and ticks fail meanwhile
		assert.ok(alive(pid), "the broker survived");
		assert.match(brokerLog(treeId), /events\.log: ENOSPC.*holding events in memory/);
		assert.match(brokerLog(treeId), /status\.json write failed: ENOSPC/);
		assert.equal(brokerLog(treeId).match(/status\.json write failed/g)!.length, 1, "reported once");
	} finally {
		diskFull(false);
	}
	await until("the held events to be written", () => /events\.log is writable again/.test(brokerLog(treeId)));
	await until("status.json to be written again", () => /status\.json write works again/.test(brokerLog(treeId)));
	assert.equal(JSON.parse(readFileSync(join(dir, "status.json"), "utf8")).agents.find((a: { id: string }) => a.id === childId).status, "down");
	// The held events reached the log: a restarted broker replays the failed child.
	const welcomed = new Promise<void>((res) => root.once("welcome", () => res()));
	await killBroker(treeId);
	await welcomed;
	const child = (await root.inspect())?.agents.find((a) => a.id === childId);
	assert.deepEqual([child?.status, child?.reason], ["down", "error:start_failed"]);
	root.stopTree();
	root.close();
});

test("inspect of a tree with 250 agents, 245 ended, fits one frame: the running ones and the newest ended are listed", async () => {
	const treeId = `big${process.pid % 1000}`;
	const dir = treeDir(treeId);
	mkdirSync(dir, { recursive: true });
	const st: TreeState = initial(treeId, { maxDepth: 2, maxSpawns: 50 }, Date.now());
	const root = st.agents[ROOT];
	for (let i = 0; i < 250; i++) {
		const id = `worker-${String(i).padStart(3, "0")}`;
		const down = i < 245;
		st.agents[id] = {
			...structuredClone(root), id, parent: ROOT, depth: 1, status: down ? "down" : "disconnected", reason: down ? "normal" : undefined, procGone: down,
			deadline: down ? undefined : Date.now() + 600_000, sessionFile: join(dir, "sessions", `2026-11-10T18-00-00-000Z_${"0".repeat(36)}.jsonl`),
			spec: { task: `${id}: ${"a long task description ".repeat(40)}`, context: "fresh", placement: "headless", model: "anthropic/claude-opus-5-5" },
		};
		st.mailbox[id] = [];
		st.leases[id] = {};
	}
	st.agents[ROOT].spawns = 250;
	writeFileSync(join(dir, "events.log"), `${JSON.stringify({ pia_log: 1, treeId })}\n${JSON.stringify({ snapshot: st, t: Date.now() })}\n`);
	const { root: client } = await tree(treeId);
	const snap = await client.inspect();
	assert.ok(snap, "the broker answered (0.2.9 failed with too_large and never did)");
	assert.ok(Buffer.byteLength(JSON.stringify(snap)) < LIMITS.frameBytes * 2);
	const listed = new Set(snap.agents.map((a) => a.id));
	for (let i = 245; i < 250; i++) assert.ok(listed.has(`worker-${i}`), `running worker-${i} listed`);
	assert.ok(listed.has("worker-244") && listed.has(ROOT), "the newest ended and the root are listed");
	assert.ok(!listed.has("worker-000"), "the oldest ended are not");
	assert.equal(snap.omitted, 251 - snap.agents.length);
	assert.equal(snap.liveChildren, 5);
	assert.ok(!/too_large/.test(brokerLog(treeId)));
	// status.json still lists every agent.
	await until("status.json", () => existsSync(join(dir, "status.json")) && JSON.parse(readFileSync(join(dir, "status.json"), "utf8")).agents?.length === 251);
	client.stopTree();
	client.close();
});
