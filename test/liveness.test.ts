// An agent's connection never stalls silently (issue #5): a real broker behind a proxy that
// swallows frames, and the client's clock mocked so the real thresholds (TIMING) are exercised
// in milliseconds. The broker and the fake children run on real time in their own processes.

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { after, afterEach, before, mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "../src/client/connection.ts";
import { ensureBroker } from "../src/client/launcher.ts";
import { ENTRY_TYPE, Mailroom } from "../src/client/mailroom.ts";
import { type Message, type Response, TIMING } from "../src/protocol.ts";

const home = mkdtempSync("/tmp/pia-live-");
const fake = fileURLToPath(new URL("./fixtures/fake-agent.ts", import.meta.url));
const realSetTimeout = globalThis.setTimeout; // captured before any test mocks it
const realSleep = (ms: number) => new Promise<void>((r) => realSetTimeout(r, ms));
let n = 0;
const clients: Client[] = [];
const servers: Server[] = [];

before(() => {
	process.env.PI_ACTORS_HOME = home;
	process.env.PI_ACTORS_SOCKET_DIR = join(home, "s");
});
afterEach(() => {
	for (const c of clients.splice(0)) c.close();
	mock.timers.reset();
});
after(async () => {
	for (const s of servers) s.close();
	try {
		execSync(`pkill -f ${JSON.stringify(home)}`);
	} catch {
		// nothing left
	}
	await realSleep(300);
	rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

type Frame = Record<string, any>;

/**
 * A pass-through between an agent and its broker. `toAgent` / `toBroker` return false to swallow
 * a frame on connection `conn` (1-based) while the socket stays open.
 */
async function proxy(upstream: string, faults: { toAgent?: (f: Frame, conn: number) => boolean; toBroker?: (f: Frame, conn: number) => boolean }) {
	const sock = join(home, `p${++n}.sock`);
	const lastToAgent: number[] = [];
	const closedAt: number[] = [];
	let conns = 0;
	const pipe = (from: Socket, to: Socket, keep: (f: Frame) => boolean, onPass?: () => void) => {
		let buf = "";
		from.setEncoding("utf8");
		from.on("data", (d: string) => {
			const lines = (buf + d).split("\n");
			buf = lines.pop() ?? "";
			for (const line of lines) {
				if (!line || !keep(JSON.parse(line))) continue;
				to.write(`${line}\n`);
				onPass?.();
			}
		});
		from.on("error", () => {});
		from.on("close", () => to.destroy());
	};
	const server = createServer((agent) => {
		const i = ++conns;
		const broker = connect(upstream);
		pipe(agent, broker, (f) => faults.toBroker?.(f, i) ?? true);
		pipe(broker, agent, (f) => faults.toAgent?.(f, i) ?? true, () => (lastToAgent[i] = Date.now()));
		agent.on("close", () => (closedAt[i] = Date.now()));
	});
	await new Promise<void>((r) => server.listen(sock, r));
	servers.push(server);
	return { sock, conns: () => conns, lastToAgent, closedAt };
}

async function tree() {
	const launch = { treeId: `lv${++n}${process.pid % 1000}`, rootCwd: home, childCommand: [process.execPath, fake] };
	return ensureBroker(launch);
}

/** The client's timers and clock run on mocked time from here on. */
function mockClock() {
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.now() });
}

/** Advance mocked time in small steps, letting real I/O run in between, until `done` holds. */
async function advanceUntil(done: () => boolean, what: string, maxMs = 600_000): Promise<number> {
	const start = Date.now();
	while (!done()) {
		if (Date.now() - start > maxMs) throw new Error(`${what}: not within ${maxMs} ms of client time`);
		mock.timers.tick(200);
		await realSleep(2);
	}
	return Date.now() - start;
}

const advance = (ms: number) => {
	const end = Date.now() + ms;
	return advanceUntil(() => Date.now() >= end, "advance", ms + 1000);
};

/** Settle a promise while advancing mocked time. */
async function settled<T>(p: Promise<T>, what: string): Promise<T> {
	let out: { v: T } | undefined;
	void p.then((v) => (out = { v }));
	await advanceUntil(() => !!out, what);
	return out!.v;
}

/**
 * The root agent as the extension wires it: a mail notice or a welcome with mail drains the
 * Mailroom; each batch is "shown to the model" (recorded with the client time) and persisted at
 * once, which acks it.
 */
async function rootAgent(sock: string) {
	const c = new Client({ socket: sock, id: "root", inc: 1, pid: process.pid, sessionId: "S" }, TIMING.rootGraceMs);
	clients.push(c);
	const room = new Mailroom("root");
	const entries: unknown[] = [];
	const shown: { m: Message; at: number }[] = [];
	const deliver = async () => {
		const batch = await room.drain(c);
		if (batch.length === 0) return;
		for (const m of batch) shown.push({ m, at: Date.now() });
		entries.push({ type: "custom_message", customType: ENTRY_TYPE, details: { actors: room.stamp(batch) } });
		room.settle(entries, c);
	};
	c.on("mail", () => void deliver());
	c.on("welcome", (w: { mailbox?: number }) => (w.mailbox ?? 0) > 0 && void deliver());
	await settled(c.start(), "welcome");
	return { c, shown, ids: () => shown.map((s) => s.m.id), bodies: () => shown.map((s) => s.m.body) };
}

const spawnReq = (task: string) => ({ req: { task, context: "fresh", placement: "headless" } });
const downs = (shown: { m: Message }[]) => shown.filter((s) => s.m.kind === "down").map((s) => JSON.parse(s.m.body) as { id: string; reason: string });
const unique = (xs: string[]) => assert.equal(new Set(xs).size, xs.length, `delivered twice: ${xs.join(", ")}`);

test("AC1: when the broker sends nothing, heartbeats included, for 45 s, the agent drops the connection and reconnects", async () => {
	const broker = await tree();
	let silent = 0;
	const p = await proxy(broker, { toAgent: (_f, conn) => conn !== silent });
	mockClock();
	const { c } = await rootAgent(p.sock);
	let welcomes = 0;
	c.on("welcome", () => welcomes++);

	await advance(180_000);
	assert.equal(p.conns(), 1, "answered heartbeats keep the connection: no reconnect in 3 minutes");

	silent = 1;
	await advanceUntil(() => welcomes === 1, "reconnect after silence");
	assert.equal(p.conns(), 2);
	const silence = p.closedAt[1] - p.lastToAgent[1];
	assert.ok(silence >= TIMING.heartbeatTimeoutMs, `dropped after ${silence} ms of silence, before 45 s`);
	assert.ok(silence <= TIMING.heartbeatTimeoutMs + 1500, `dropped only after ${silence} ms of silence`);
	assert.equal(c.connected, true);
});

test("a sleep or a blocked event loop is not mistaken for a silent broker", async () => {
	const p = await proxy(await tree(), {});
	mockClock();
	await rootAgent(p.sock);
	await advance(5_000);
	// The watchdog's next check runs an hour late, before the socket's pending data is read.
	mock.timers.setTime(Date.now() + 3_600_000);
	await advance(10_000);
	assert.equal(p.conns(), 1, "no reconnect");
});

test("AC2 + INV-3: a fetch the broker never answers: delivery resumes within 60 s, each message shown once", async () => {
	const broker = await tree();
	let swallowedAt: number | undefined;
	const p = await proxy(broker, {
		toAgent: (f) => {
			if (f.t !== "fetched" || !f.message || swallowedAt !== undefined) return true;
			swallowedAt = Date.now(); // the broker leased the message; the agent never hears of it
			return false;
		},
	});
	mockClock();
	const root = await rootAgent(p.sock);
	assert.equal((await settled(root.c.op("spawn", spawnReq("echo")), "spawn")).ok, true);
	// The child mails "echo:echo" and ends (DOWN normal): both must reach the model, once.
	await advanceUntil(() => root.bodies().includes("echo:echo") && downs(root.shown).length === 1, "delivery");
	assert.ok(swallowedAt !== undefined, "the fault was injected");
	const first = Math.min(...root.shown.map((s) => s.at));
	assert.ok(first - swallowedAt! <= 60_000, `delivery resumed ${first - swallowedAt!} ms after the lost reply`);
	assert.ok(p.conns() >= 2, "recovered by reconnecting");
	await advance(60_000);
	unique(root.ids());
	assert.deepEqual(root.bodies().filter((b) => b.startsWith("echo:")), ["echo:echo"]);
	assert.equal(downs(root.shown).length, 1);
});

test("AC4: spawn, send, stop and clear whose answers are lost take effect once, and each caller gets its result", async () => {
	const broker = await tree();
	const opOf = new Map<number, string>();
	const swallow = new Set(["spawn", "send", "kill", "forget"]);
	const p = await proxy(broker, {
		toBroker: (f) => (f.t === "op" && opOf.set(f.seq, f.op), true),
		toAgent: (f) => !(f.t === "resp" && swallow.delete(opOf.get(f.seq)!)),
	});
	mockClock();
	const root = await rootAgent(p.sock);
	const children = async () => ((await settled(root.c.inspect(), "inspect"))?.agents ?? []).filter((a) => a.parent === "root");

	const spawned = (await settled(root.c.op("spawn", spawnReq("serve")), "spawn")) as Extract<Response, { type: "spawned" }>;
	assert.equal(spawned.type, "spawned");
	assert.equal((await children()).length, 1, "spawned once");

	const sent = (await settled(root.c.op("send", { to: spawned.id, kind: "mail", body: "ping" }), "send")) as Extract<Response, { type: "accepted" }>;
	assert.equal(sent.type, "accepted");
	await advanceUntil(() => root.bodies().includes("echo:ping"), "echo");

	assert.equal((await settled(root.c.op("kill", { target: spawned.id }), "stop")).ok, true);
	await advanceUntil(() => downs(root.shown).length === 1, "DOWN");
	assert.match(downs(root.shown)[0].reason, /^killed/);

	assert.equal((await settled(root.c.op("forget", { target: spawned.id }), "clear")).ok, true);
	assert.equal((await children()).length, 0, "cleared");

	assert.deepEqual([...swallow], [], "every answer was lost once");
	assert.ok(p.conns() >= 5, "each recovery reconnected");
	await advance(60_000);
	assert.deepEqual(root.bodies().filter((b) => b.startsWith("echo:")), ["echo:ping"], "the send took effect once");
	assert.equal(downs(root.shown).length, 1, "stopped once");
	unique(root.ids());
});

function prng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

test("INV-3 under random lost answers and requests: every accepted message reaches the model exactly once", async () => {
	let faults = 0;
	for (const seed of [1, 2, 3]) {
		const broker = await tree();
		const rand = prng(seed);
		let armed = false;
		let budget = 6;
		const dropped: string[] = [];
		const drop = (f: Frame, kinds: string[]) => {
			if (!armed || budget === 0 || !kinds.includes(f.t) || rand() > 0.15) return false;
			budget--;
			dropped.push(f.t);
			return true;
		};
		// Lost answers (and heartbeats), and lost requests that carry no sequence number.
		const p = await proxy(broker, {
			toAgent: (f) => !drop(f, ["welcome", "resp", "fetched", "hb"]),
			toBroker: (f) => !drop(f, ["fetch", "ack"]),
		});
		mockClock();
		const root = await rootAgent(p.sock);
		const child = (await settled(root.c.op("spawn", spawnReq("serve")), "spawn")) as Extract<Response, { type: "spawned" }>;
		armed = true;
		const N = 8;
		const sends = Array.from({ length: N }, (_, i) => root.c.op("send", { to: child.id, kind: "mail", body: `m${i}` }));
		const results = await settled(Promise.all(sends), `sends (seed ${seed})`);
		assert.ok(results.every((r) => r.ok), `seed ${seed}: ${JSON.stringify(results)}`);
		await advanceUntil(() => root.bodies().filter((b) => b.startsWith("echo:")).length >= N, `echoes (seed ${seed}, dropped ${dropped.join(",")})`);
		await advance(60_000);
		const echoes = root.bodies().filter((b) => b.startsWith("echo:")).sort();
		assert.deepEqual(echoes, Array.from({ length: N }, (_, i) => `echo:m${i}`).sort(), `seed ${seed}, dropped ${dropped.join(",")}`);
		unique(root.ids());
		faults += dropped.length;
		for (const c of clients.splice(0)) c.close();
		mock.timers.reset();
	}
	assert.ok(faults >= 3, `only ${faults} frames dropped: the property was barely exercised`);
});
