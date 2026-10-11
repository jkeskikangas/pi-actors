// An agent's connection never stalls silently (issue #5): a real broker behind a proxy that
// swallows frames, and the client's clock mocked so the real thresholds (TIMING) are exercised
// in milliseconds. The broker and the fake children run on real time in their own processes.

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { after, afterEach, before, mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "../src/client/connection.ts";
import { ensureBroker } from "../src/client/launcher.ts";
import { ENTRY_TYPE, Mailroom } from "../src/client/mailroom.ts";
import { startBroker } from "../src/broker/server.ts";
import { DEFAULT_LIMITS, type Message, PROTO, type Response, TIMING } from "../src/protocol.ts";

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
 * once. It is acked at once, or with `ackLater` only by `settle()` (one long turn), so it stays
 * in flight across reconnects.
 */
async function rootAgent(sock: string, ackLater = false) {
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
		if (!ackLater) room.settle(entries, c);
	};
	c.on("mail", () => void deliver());
	c.on("welcome", (w: { mailbox?: number }) => (w.mailbox ?? 0) > 0 && void deliver());
	await settled(c.start(), "welcome");
	return { c, shown, settle: () => room.settle(entries, c), ids: () => shown.map((s) => s.m.id), bodies: () => shown.map((s) => s.m.body) };
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

test("AC1/AC2 bound: from the broker's last frame to the next welcome takes under 60 s at every reconnect backoff step", async () => {
	let silent = 0;
	const p = await proxy(await tree(), { toAgent: (_f, conn) => conn !== silent });
	mockClock();
	const { c } = await rootAgent(p.sock);
	const welcomedAt: number[] = [];
	c.on("welcome", () => welcomedAt.push(Date.now()));
	const took: number[] = [];
	// The backoff grows with the client's request counter (reset at welcome): k requests before
	// the silence give a 500 * 2^k ms backoff, capped at 5 s.
	for (let k = 0; k <= 4; k++) {
		for (let i = 0; i < k; i++) await settled(c.inspect(), "inspect");
		silent = p.conns();
		const before = welcomedAt.length;
		await advanceUntil(() => welcomedAt.length > before, `reconnect ${k}`);
		took.push(welcomedAt.at(-1)! - p.lastToAgent[silent]);
	}
	assert.ok(took.every((ms) => ms < 60_000), `last frame -> welcome: ${took.join(", ")} ms`);
	assert.ok(Math.max(...took) >= TIMING.heartbeatTimeoutMs + 5000, `the 5 s backoff was exercised: ${took.join(", ")} ms`);
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
	for (const seed of [1, 2, 3, 4]) {
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
		const root = await rootAgent(p.sock, seed % 2 === 1);
		const child = (await settled(root.c.op("spawn", spawnReq("serve")), "spawn")) as Extract<Response, { type: "spawned" }>;
		armed = true;
		const N = 8;
		const sends = Array.from({ length: N }, (_, i) => root.c.op("send", { to: child.id, kind: "mail", body: `m${i}` }));
		const results = await settled(Promise.all(sends), `sends (seed ${seed})`);
		assert.ok(results.every((r) => r.ok), `seed ${seed}: ${JSON.stringify(results)}`);
		await advanceUntil(() => root.bodies().filter((b) => b.startsWith("echo:")).length >= N, `echoes (seed ${seed}, dropped ${dropped.join(",")})`);
		root.settle();
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

// ---------------------------------------------------------------- a hello outlived by its connection
// Since the agent drops a connection the broker is slow to answer, a hello the broker is still
// checking can belong to a connection that is already gone. Applying it then must change nothing:
// before the fix it superseded the agent's new, live connection, and the agent shut itself down.

/** An in-process broker whose pane placement is a fake tmux and whose Keepers do nothing. */
async function inProcessBroker(mux: "tmux" | undefined) {
	const id = `ip${++n}`;
	const runtimeDir = join(home, id, "rt");
	mkdirSync(join(runtimeDir, "keeper"), { recursive: true });
	writeFileSync(join(runtimeDir, "keeper", "main.ts"), ""); // the test plays the Keeper
	const sock = join(home, "s", `${id}.sock`);
	const broker = await startBroker(join(home, id, "tree"), sock, { treeId: id, limits: DEFAULT_LIMITS, rootCwd: home, piCommand: ["pi"], runtimeDir, mux, rootPaneId: mux ? "%0" : undefined });
	const root = new Client({ socket: sock, id: "root", inc: 1, pid: process.pid, sessionId: "S" });
	clients.push(root);
	await root.start();
	return { broker, sock, root, dir: join(home, id) };
}

const rawHello = async (sock: string, id: string, pid: number) => {
	const s = connect(sock);
	s.on("error", () => {});
	await new Promise((r) => s.once("connect", r));
	s.write(`${JSON.stringify({ t: "hello", proto: PROTO, id, inc: 1, pid })}\n`);
	return s;
};

async function waitFor(cond: () => boolean, what: string, ms = 8000) {
	const end = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > end) throw new Error(`${what}: not within ${ms} ms`);
		await realSleep(20);
	}
}

test("a slow hello finishing after its connection dropped does not supersede the agent's new connection", async () => {
	// tmux's pane-pid lookup (the pane child's identity check) blocks on its first call until the
	// test opens the gate; later lookups answer at once.
	const bin = join(home, "faketmux");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "tmux"), `#!/bin/sh
case "$*" in
  *pane_pid*) if mkdir "${bin}/first" 2>/dev/null; then while [ ! -e "${bin}/gate" ]; do sleep 0.02; done; fi; echo ${process.pid} ;;
  display-message*) echo %0 ;;
  split-window*) echo %1 ;;
  list-panes*) printf '%%0\\n%%1\\n' ;;
esac
`);
	chmodSync(join(bin, "tmux"), 0o755);
	process.env.TMUX_BIN = join(bin, "tmux");
	const { broker, sock, root } = await inProcessBroker("tmux");
	try {
		const kid = (await root.op("spawn", { req: { task: "t", context: "fresh", placement: "pane" } })) as Extract<Response, { type: "spawned" }>;
		await waitFor(() => !!broker.state.agents[kid.id]?.paneId, "placed");

		const conn1 = await rawHello(sock, kid.id, process.pid); // hello 1: its identity check hangs
		await waitFor(() => existsSync(join(bin, "first")), "hello 1 being checked");
		conn1.destroy(); // the agent gives up on it
		await realSleep(100);

		const c = new Client({ socket: sock, id: kid.id, inc: 1, pid: process.pid });
		clients.push(c);
		let superseded = false;
		c.on("superseded", () => (superseded = true));
		await c.start(); // hello 2 is welcomed

		writeFileSync(join(bin, "gate"), ""); // hello 1's check completes
		await realSleep(500);
		assert.equal(superseded, false, "the live connection was superseded by a dead one");
		assert.equal(c.connected, true);
		assert.equal(broker.state.agents[kid.id].connected, true);
		const r = await Promise.race([c.op("send", { to: "root", kind: "mail", body: "still here" }), realSleep(3000).then(() => "no answer")]);
		assert.equal((r as Response).ok, true, `the broker serves the new connection: ${JSON.stringify(r)}`);
	} finally {
		delete process.env.TMUX_BIN;
		for (const c of clients.splice(0)) c.close();
		await broker.stop();
	}
});

test("a held hello resumed by proc_start after its connection dropped changes nothing", async () => {
	const { broker, sock, root } = await inProcessBroker(undefined);
	try {
		const kid = (await root.op("spawn", { req: { task: "t", context: "fresh", placement: "headless" } })) as Extract<Response, { type: "spawned" }>;
		const keeper = connect(sock);
		keeper.on("error", () => {});
		await new Promise((r) => keeper.once("connect", r));
		keeper.write(`${JSON.stringify({ t: "keeper_hello", proto: PROTO, id: kid.id, inc: 1, keeper_pid: process.pid })}\n`);

		const conn1 = await rawHello(sock, kid.id, process.pid); // held: the Keeper has not reported the process yet
		await realSleep(100);
		conn1.destroy();
		await realSleep(100);
		const before = structuredClone(broker.state.agents[kid.id]);
		keeper.write(`${JSON.stringify({ t: "proc_start", pid: process.pid, pgid: process.pid })}\n`);
		await realSleep(200);
		const a = broker.state.agents[kid.id];
		assert.deepEqual([a.status, a.connected, a.conn], [before.status, false, before.conn], "the dead connection's hello was applied");

		const c = new Client({ socket: sock, id: kid.id, inc: 1, pid: process.pid });
		clients.push(c);
		await c.start();
		assert.equal(broker.state.agents[kid.id].status, "live", "the next hello is welcomed");
		keeper.destroy();
	} finally {
		for (const c of clients.splice(0)) c.close();
		await broker.stop();
	}
});
