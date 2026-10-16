// Model-free integration: a real broker (started by the Launcher from a runtime snapshot), real
// Keepers, and fake agent processes (test/fixtures/fake-agent.ts) that speak the protocol.

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "../src/client/connection.ts";
import { ensureBroker } from "../src/client/launcher.ts";
import type { Message } from "../src/protocol.ts";
import { socketPath as socketPathFor, treeDir } from "../src/runtime.ts";

const home = mkdtempSync("/tmp/pia-home-");
const fake = fileURLToPath(new URL("./fixtures/fake-agent.ts", import.meta.url));
let treeN = 0;

before(() => {
	process.env.PI_ACTORS_HOME = home;
	process.env.PI_ACTORS_SOCKET_DIR = join(home, "s");
});
const clients: Client[] = [];
after(async () => {
	for (const c of clients) c.close();
	// Kill everything this suite started, even after a failed test.
	try {
		execSync(`pkill -f ${JSON.stringify(home)}`);
	} catch {
		// nothing left
	}
	// Killed brokers may still be writing their last status file: retry the removal.
	await new Promise((r) => setTimeout(r, 300));
	rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function tree() {
	const treeId = `t${++treeN}${process.pid % 1000}`;
	const launch = { treeId, rootCwd: home, childCommand: [process.execPath, fake] };
	const socket = await ensureBroker(launch);
	// Like the extension's root: relaunch the broker before reconnecting (F10).
	const root = new Client({ socket, id: "root", inc: 1, pid: process.pid, sessionId: "S" }, 15_000, () => ensureBroker(launch).then(() => {}));
	clients.push(root);
	await root.start();
	return { treeId, socket, root };
}

// At-least-once: an ack lost in a broker crash means redelivery. Like the real client, the test
// drops message ids it has already consumed.
const consumed = new WeakMap<Client, Set<string>>();

async function receive(c: Client, filter: Parameters<Client["fetch"]>[0] = {}, ms = 15_000): Promise<Message> {
	const end = Date.now() + ms;
	const seen = consumed.get(c) ?? new Set<string>();
	consumed.set(c, seen);
	while (Date.now() < end) {
		const m = await c.fetch(filter);
		if (m && seen.has(m.id)) {
			c.ack(m.id);
			continue;
		}
		if (m) {
			seen.add(m.id);
			c.ack(m.id);
			return m;
		}
		await c.waitForMail(200);
	}
	throw new Error(`no message matching ${JSON.stringify(filter)} within ${ms} ms`);
}

const spawnReq = (task: string) => ({ req: { task, context: "fresh", placement: "headless" } });

test("spawn → child mail → exit → DOWN normal with result", async () => {
	const { root } = await tree();
	const r = await root.op("spawn", spawnReq("echo"));
	assert.equal(r.ok, true);
	const mail = await receive(root, { kind: "mail" });
	assert.equal(mail.body, "echo:echo");
	const down = JSON.parse((await receive(root, { kind: "down" })).body);
	assert.deepEqual([down.reason, down.result], ["normal", "echoed"]);
	root.stopTree();
	root.close();
});

test("a fast spawn starts the child with --actors-fast=1 and shows fast in the snapshot", async () => {
	const { root } = await tree();
	const r = (await root.op("spawn", { req: { task: "argv", context: "fresh", placement: "headless", fast: true } })) as { id: string };
	assert.ok(JSON.parse((await receive(root, { kind: "mail" })).body).includes("--actors-fast=1"));
	assert.equal((await root.inspect())?.agents.find((a) => a.id === r.id)?.fast, true);
	root.stopTree();
	root.close();
});

test("a served child answers mail with reply_to; its end carries its result", async () => {
	const { root } = await tree();
	const r = (await root.op("spawn", spawnReq("serve"))) as { id: string };
	const sent = (await root.op("send", { to: r.id, kind: "mail", body: "q1" })) as { msgId: string };
	assert.equal((await receive(root, { ref: sent.msgId })).body, "echo:q1");
	await root.op("send", { to: r.id, kind: "mail", body: "bye" });
	const down = JSON.parse((await receive(root, { kind: "down" })).body);
	assert.equal(down.result, "served");
	root.stopTree();
	root.close();
});

test("a crashed child produces DOWN error:crashed", async () => {
	const { root } = await tree();
	await root.op("spawn", spawnReq("crash"));
	const down = JSON.parse((await receive(root, { kind: "down" })).body);
	assert.match(down.reason, /^error:crashed\(3\)/);
	root.stopTree();
	root.close();
});

test("exit{target} by an ancestor kills a child", async () => {
	const { root } = await tree();
	const r = (await root.op("spawn", spawnReq("serve"))) as { id: string };
	await root.op("send", { to: r.id, kind: "mail", body: "ping" }).then((x) => receive(root, { ref: (x as { msgId: string }).msgId }));
	assert.equal((await root.op("kill", { target: r.id })).ok, true);
	const down = JSON.parse((await receive(root, { kind: "down" })).body);
	assert.match(down.reason, /^killed/);
	root.stopTree();
	root.close();
});

test("broker SIGKILL: the child survives under its Keeper, everyone reconnects, messages flow again", async () => {
	const { treeId, root } = await tree();
	const r = (await root.op("spawn", spawnReq("serve"))) as { id: string };
	await root.op("send", { to: r.id, kind: "mail", body: "before" });
	assert.equal((await receive(root, { kind: "mail" })).body, "echo:before");
	const lock = JSON.parse(readFileSync(join(treeDir(treeId), "broker.lock"), "utf8"));
	process.kill(lock.pid, "SIGKILL");
	// No manual relaunch: the root's client brings the broker back on its own (F10).
	await new Promise<void>((res) => root.once("welcome", () => res()));
	await root.op("send", { to: r.id, kind: "mail", body: "after" });
	assert.equal((await receive(root, { kind: "mail" })).body, "echo:after", "same child, same mailbox, after the crash");
	await root.op("send", { to: r.id, kind: "mail", body: "bye" });
	const down = JSON.parse((await receive(root, { kind: "down" })).body);
	assert.equal(down.reason, "normal");
	root.stopTree();
	root.close();
});

test("run state: the broker reports a child running while it says so, again after a broker crash, never once it is down", async () => {
	const { treeId, root } = await tree();
	const r = (await root.op("spawn", spawnReq("serve"))) as { id: string };
	const running = async () => (await root.inspect())?.agents.find((a) => a.id === r.id)?.running;
	const ask = async (body: string) => {
		const sent = (await root.op("send", { to: r.id, kind: "mail", body })) as { msgId: string };
		await receive(root, { ref: sent.msgId });
	};
	await ask("hello");
	assert.equal(await running(), false, "a live child that has not started a run");
	await ask("busy");
	assert.equal(await running(), true);
	await ask("idle");
	assert.equal(await running(), false);
	await ask("busy");
	const lock = JSON.parse(readFileSync(join(treeDir(treeId), "broker.lock"), "utf8"));
	process.kill(lock.pid, "SIGKILL");
	await new Promise<void>((res) => root.once("welcome", () => res()));
	const end = Date.now() + 15_000;
	while ((await running()) !== true && Date.now() < end) await new Promise((res) => setTimeout(res, 200));
	assert.equal(await running(), true, "the reconnected child restates its run");
	assert.equal((await root.op("kill", { target: r.id })).ok, true);
	await receive(root, { kind: "down" });
	assert.equal(await running(), false);
	root.stopTree();
	root.close();
});

test("broker SIGTERM stops the broker, not the tree: the child survives, a relaunched broker serves it again", async () => {
	const { treeId, root } = await tree();
	const r = (await root.op("spawn", spawnReq("serve"))) as { id: string };
	await root.op("send", { to: r.id, kind: "mail", body: "before" });
	assert.equal((await receive(root, { kind: "mail" })).body, "echo:before");
	const lock = JSON.parse(readFileSync(join(treeDir(treeId), "broker.lock"), "utf8"));
	process.kill(lock.pid, "SIGTERM");
	await new Promise<void>((res) => root.once("welcome", () => res()));
	const sent = await root.op("send", { to: r.id, kind: "mail", body: "after" });
	assert.equal(sent.ok, true, JSON.stringify(sent));
	assert.equal((await receive(root, { kind: "mail" })).body, "echo:after", "the same child still runs after a SIGTERM restart");
	await root.op("send", { to: r.id, kind: "mail", body: "bye" });
	assert.equal(JSON.parse((await receive(root, { kind: "down" })).body).reason, "normal");
	root.stopTree();
	root.close();
});

test("one connection's frames apply in arrival order: an op right behind a spawn{resume} is not overtaken into seq_gap", async () => {
	const { root } = await tree();
	const r = (await root.op("spawn", spawnReq("crash"))) as { id: string };
	await receive(root, { kind: "down" });
	// Both frames in one write, as the root sent ops 179 and 180 in the incident.
	const sock = (root as unknown as { sock: import("node:net").Socket }).sock;
	const seq = (root as unknown as { nextSeq: number }).nextSeq;
	const resps = new Map<number, Record<string, unknown>>();
	let buf = "";
	const got = new Promise<void>((res) => {
		sock.on("data", (d: string) => {
			const lines = (buf + d).split("\n");
			buf = lines.pop() ?? "";
			for (const l of lines) {
				const f = l ? JSON.parse(l) : {};
				if (f.t === "resp") resps.set(f.seq, f.response);
			}
			if (resps.has(seq) && resps.has(seq + 1)) res();
		});
	});
	sock.write(`${JSON.stringify({ t: "op", seq, op: "spawn", req: { task: "serve", context: "fresh", placement: "headless", resume: r.id } })}\n${JSON.stringify({ t: "op", seq: seq + 1, op: "send", to: r.id, kind: "mail", body: "x" })}\n`);
	await got;
	assert.equal(resps.get(seq)?.ok, true, JSON.stringify(resps.get(seq)));
	assert.equal(resps.get(seq + 1)?.ok, true, `the op behind the resume: ${JSON.stringify(resps.get(seq + 1))}`);
	root.stopTree();
	root.close();
});

/** A scripted stand-in broker: it welcomes every hello and lets `onOp` answer each op frame. */
async function fakeBroker(onOp: (f: Record<string, any>, conn: number, write: (o: object) => void) => void, lastSeq = () => 0) {
	const sock = join(home, `fb${++treeN}.sock`);
	let conns = 0;
	const server = createServer((s) => {
		const conn = ++conns;
		let buf = "";
		s.setEncoding("utf8");
		const write = (o: object) => s.write(`${JSON.stringify(o)}\n`);
		s.on("data", (d: string) => {
			const lines = (buf + d).split("\n");
			buf = lines.pop() ?? "";
			for (const l of lines) {
				if (!l) continue;
				const f = JSON.parse(l);
				if (f.t === "hello") write({ t: "welcome", lastSeq: lastSeq(), mailbox: 0, id: f.id, inc: f.inc, parent: null, treeId: "fake" });
				if (f.t === "op") onOp(f, conn, write);
			}
		});
		s.on("error", () => {});
	});
	await new Promise<void>((r) => server.listen(sock, r));
	return { sock, server };
}

test("seq_gap from an out-of-order broker: the client resends the held op once its predecessor lands; each op applies once, in order", async () => {
	// An old (0.2.6) broker: op 1 is still being processed when op 2 arrives and is refused.
	let last = 0;
	const applied: string[] = [];
	let held: (() => void) | undefined;
	const { sock, server } = await fakeBroker((f, _c, write) => {
		const apply = () => {
			if (f.seq === last + 1) {
				last = f.seq;
				applied.push(`${f.seq}:${f.body}`);
				write({ t: "resp", seq: f.seq, response: { ok: true, type: "accepted", msgId: `root:1:${f.seq}` } });
			} else if (f.seq <= last) write({ t: "resp", seq: f.seq, response: { ok: true, type: "accepted", msgId: `root:1:${f.seq}` } });
			else write({ t: "resp", seq: f.seq, response: { ok: false, error: "seq_gap", detail: `expected ${last + 1}` } });
		};
		if (f.body === "slow" && !held) {
			held = apply;
			return;
		}
		apply();
		if (held) {
			const h = held;
			held = () => {};
			setTimeout(h, 50);
		}
	});
	try {
		const c = new Client({ socket: sock, id: "root", inc: 1, pid: process.pid }, 5000);
		clients.push(c);
		await c.start();
		const rs = await Promise.all([c.op("send", { to: "x", kind: "mail", body: "slow" }), c.op("send", { to: "x", kind: "mail", body: "b" }), c.op("send", { to: "x", kind: "mail", body: "c" })]);
		assert.deepEqual(rs.map((r) => r.ok), [true, true, true], JSON.stringify(rs));
		assert.deepEqual(applied, ["1:slow", "2:b", "3:c"]);
		const after = await c.op("send", { to: "x", kind: "mail", body: "d" });
		assert.equal(after.ok, true, "later ops are not wedged on a stale expected seq");
		assert.deepEqual(applied, ["1:slow", "2:b", "3:c", "4:d"]);
	} finally {
		server.close();
	}
});

test("seq_gap for a seq the client no longer holds: it reconnects, renumbers from the broker's last seq, and applies the op once", async () => {
	// Op 1 is answered not_live without being applied (a stale-connection answer); op 2 then gaps.
	let last = 0;
	const applied: string[] = [];
	const { sock, server } = await fakeBroker((f, conn, write) => {
		if (conn === 1 && f.body === "lost") return write({ t: "resp", seq: f.seq, response: { ok: false, error: "not_live", detail: "not the current connection" } });
		if (f.seq === last + 1) {
			last = f.seq;
			applied.push(`${f.seq}:${f.body}`);
			write({ t: "resp", seq: f.seq, response: { ok: true, type: "accepted", msgId: `root:1:${f.seq}` } });
		} else if (f.seq > last + 1) write({ t: "resp", seq: f.seq, response: { ok: false, error: "seq_gap", detail: `expected ${last + 1}` } });
	}, () => last);
	try {
		const c = new Client({ socket: sock, id: "root", inc: 1, pid: process.pid }, 10_000);
		clients.push(c);
		await c.start();
		const lost = await c.op("send", { to: "x", kind: "mail", body: "lost" });
		assert.equal(lost.ok, false, "the lost op fails with a clear error, never silently");
		const r2 = await c.op("send", { to: "x", kind: "mail", body: "b" });
		assert.equal(r2.ok, true, JSON.stringify(r2));
		const r3 = await c.op("send", { to: "x", kind: "mail", body: "c" });
		assert.equal(r3.ok, true, JSON.stringify(r3));
		assert.deepEqual(applied, ["1:b", "2:c"]);
	} finally {
		server.close();
	}
});

test("F1: a child that cannot start (missing cwd) ends at once with error:start_failed; the broker survives", async () => {
	const { root } = await tree();
	await root.op("spawn", { req: { task: "echo", context: "fresh", placement: "headless", cwd: join(home, "no", "such", "dir") } });
	const down = JSON.parse((await receive(root, { kind: "down" }, 8000)).body);
	assert.equal(down.reason, "error:start_failed");
	assert.equal((await root.op("spawn", spawnReq("echo"))).ok, true, "broker still serving");
	root.stopTree();
	root.close();
});

test("F3: concurrent launchers for one tree start exactly one broker", async () => {
	const treeId = `lk${process.pid % 1000}`;
	await Promise.all(Array.from({ length: 6 }, () => ensureBroker({ treeId, rootCwd: home, childCommand: [process.execPath, fake] })));
	await new Promise((r) => setTimeout(r, 800));
	const log = readFileSync(join(treeDir(treeId), "broker.log"), "utf8");
	assert.equal((log.match(/listening/g) ?? []).length, 1, log);
	const root = new Client({ socket: socketPathFor(treeId), id: "root", inc: 1, pid: process.pid, sessionId: "S" }, 5000);
	clients.push(root);
	await root.start();
	root.stopTree();
	root.close();
});

test("N3: a broker that goes away before welcoming fails the connect instead of hanging it", async () => {
	const sock = join(home, "n3.sock");
	const server = createServer((s) => s.destroy());
	await new Promise<void>((r) => server.listen(sock, r));
	try {
		const c = new Client({ socket: sock, id: "root", inc: 1, pid: process.pid }, 200);
		const outcome = await Promise.race([c.start().then(() => "welcomed", (e: Error) => `failed: ${e.message}`), new Promise((r) => setTimeout(() => r("hung"), 5000))]);
		assert.match(String(outcome), /^failed/);
	} finally {
		server.close();
	}
});
