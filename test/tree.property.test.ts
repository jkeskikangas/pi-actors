// Property tests: a TypeScript port of the Quint model's environment (model/pi_actors.qnt)
// drives the real Tree reducer with random events and checks the model's invariants after
// every step. Broker crashes rebuild state by replaying the event log, which also checks D2:
// replay + recover equals live state + recover.

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_LIMITS, type Limits, type Message } from "../src/protocol.ts";
import { apply, type Effect, type Event, initial, replay, ROOT, type TreeState } from "../src/tree.ts";

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

interface Client {
	procAlive: boolean;
	exitPending: boolean;
	keeperReported: boolean;
	pid: number;
	nextSeq: number;
	inflight: Event[];
	fetched: Message[];
	pendingAck: Set<string>;
	persisted: Set<string>;
	lastSeen: Map<string, number>;
}

interface World {
	st: TreeState;
	log: Event[];
	brokerUp: boolean;
	now: number;
	clients: Map<string, Client>;
	downEffects: Map<string, number>;
	accepted: Map<string, string>; // msgId -> receiver, for mail the sender saw accepted
	violations: string[];
	faults: number;
	pidCounter: number;
	fetchCounter: number;
}

const LIMITS: Limits = { maxDepth: 2, maxSpawns: 5 };
const MAX_FAULTS = 3;
const MAX_SENT = 6;

function newClient(pid: number, alive: boolean): Client {
	return { procAlive: alive, exitPending: false, keeperReported: false, pid, nextSeq: 1, inflight: [], fetched: [], pendingAck: new Set(), persisted: new Set(), lastSeen: new Map() };
}

function world(): World {
	const w: World = {
		st: initial("p", LIMITS, 0), log: [], brokerUp: true, now: 0, clients: new Map([[ROOT, newClient(1, true)]]),
		downEffects: new Map(), accepted: new Map(), violations: [], faults: 0, pidCounter: 10, fetchCounter: 0,
	};
	w.clients.get(ROOT)!.keeperReported = true;
	run(w, { type: "hello", now: 0, id: ROOT, inc: 1, pid: 1, sessionId: "S", ownsPid: true });
	return w;
}

function run(w: World, ev: Event): Effect[] {
	assert.ok(w.brokerUp, "events only reach a running broker");
	const r = apply(w.st, ev);
	w.st = r.state;
	w.log.push(ev);
	for (const e of r.effects) {
		if (e.type === "down") w.downEffects.set(`${e.id}:${e.inc}`, (w.downEffects.get(`${e.id}:${e.inc}`) ?? 0) + 1);
		if (e.type === "start") w.clients.set(e.id, newClient(++w.pidCounter, true));
		if (e.type === "signal") {
			const c = w.clients.get(e.id);
			if (c?.procAlive) stopProcess(c);
		}
	}
	return r.effects;
}

function stopProcess(c: Client) {
	c.procAlive = false;
	c.exitPending = true;
	c.inflight = [];
	c.fetched = [];
	c.pendingAck = new Set();
	c.nextSeq = 1;
}

const agent = (w: World, id: string) => w.st.agents[id];
const canAct = (w: World, id: string) => {
	const a = agent(w, id);
	return w.brokerUp && !!a && a.connected && a.status === "live" && !!w.clients.get(id)?.procAlive;
};
const seqOf = (msgId: string) => Number(msgId.split(":")[2]);

// ---------------------------------------------------------------- actions (mirror the model)

type Action = (w: World, pick: <T>(xs: T[]) => T | undefined) => boolean;

const actions: Record<string, Action> = {
	spawn(w, pick) {
		const p = pick(Object.keys(w.st.agents).filter((id) => canAct(w, id)));
		if (!p) return false;
		const c = w.clients.get(p)!;
		c.inflight.push({ type: "spawn", now: w.now, from: p, seq: c.nextSeq++, req: { task: "t", context: "fresh", placement: "headless" } });
		return true;
	},
	keeperStart(w, pick) {
		const id = pick([...w.clients.entries()].filter(([id, c]) => c.procAlive && !c.keeperReported && agent(w, id)).map(([id]) => id));
		if (!id || !w.brokerUp) return false;
		w.clients.get(id)!.keeperReported = true;
		run(w, { type: "procStart", id, inc: agent(w, id).inc, pid: w.clients.get(id)!.pid });
		return true;
	},
	hello(w, pick) {
		const id = pick(Object.keys(w.st.agents).filter((id) => {
			const a = agent(w, id);
			return w.brokerUp && !a.connected && w.clients.get(id)?.procAlive && ["starting", "live", "disconnected", "exiting", "killing"].includes(a.status);
		}));
		if (!id) return false;
		const c = w.clients.get(id)!;
		const fx = run(w, { type: "hello", now: w.now, id, inc: agent(w, id).inc, pid: c.pid, sessionId: id === ROOT ? "S" : undefined, ownsPid: true, recordedPidAlive: true });
		const welcome = fx.find((e) => e.type === "welcome");
		if (welcome && welcome.type === "welcome" && c.inflight.length === 0) c.nextSeq = welcome.lastSeq + 1;
		return true;
	},
	send(w, pick) {
		if (w.accepted.size >= MAX_SENT) return false;
		const src = pick(Object.keys(w.st.agents).filter((id) => canAct(w, id)));
		const dst = pick(Object.keys(w.st.agents).filter((id) => id !== src));
		if (!src || !dst) return false;
		const c = w.clients.get(src)!;
		c.inflight.push({ type: "send", now: w.now, from: src, seq: c.nextSeq++, to: dst, kind: "mail", body: `m${w.log.length}` });
		return true;
	},
	// Broker applies the oldest in-flight frame; the client sees the response only via clientAccepted.
	brokerAccept(w, pick) {
		const id = pick([...w.clients.keys()].filter((id) => w.brokerUp && agent(w, id)?.connected && w.clients.get(id)!.inflight.length > 0));
		if (!id) return false;
		run(w, w.clients.get(id)!.inflight[0]);
		return true;
	},
	clientAccepted(w, pick) {
		const id = pick([...w.clients.keys()].filter((id) => {
			const c = w.clients.get(id)!;
			const head = c.inflight[0] as { seq: number } | undefined;
			return w.brokerUp && agent(w, id)?.connected && head !== undefined && head.seq <= (w.st.seq[`${id}:${agent(w, id).inc}`]?.last ?? 0);
		}));
		if (!id) return false;
		const c = w.clients.get(id)!;
		const head = c.inflight.shift()!;
		const resp = w.st.seq[`${id}:${agent(w, id).inc}`].cache[(head as { seq: number }).seq];
		if (head.type === "send" && resp?.ok && resp.type === "accepted") w.accepted.set(resp.msgId, head.to);
		return true;
	},
	fetch(w, pick) {
		const id = pick(Object.keys(w.st.agents).filter((id) => canAct(w, id) && w.clients.get(id)!.fetched.length < 2));
		if (!id) return false;
		const fx = run(w, { type: "fetch", id, fetchId: `f${++w.fetchCounter}` });
		const f = fx.find((e) => e.type === "fetched");
		const m = f && f.type === "fetched" ? f.message : null;
		if (!m) return true;
		const c = w.clients.get(id)!;
		// Client dedupe at fetch time: already consumed, or still being delivered (in flight
		// across a broker restart).
		if (c.persisted.has(m.id)) c.pendingAck.add(m.id);
		else if (!c.fetched.some((x) => x.id === m.id)) c.fetched.push(m);
		return true;
	},
	persist(w, pick) {
		const id = pick([...w.clients.keys()].filter((id) => w.clients.get(id)!.procAlive && w.clients.get(id)!.fetched.length > 0));
		if (!id) return false;
		const c = w.clients.get(id)!;
		const m = c.fetched.shift()!;
		if (c.persisted.has(m.id)) w.violations.push(`consumed twice: ${id} ${m.id}`);
		if (m.kind === "mail" && !m.id.startsWith("broker:")) {
			const prev = c.lastSeen.get(m.from) ?? 0;
			if (seqOf(m.id) <= prev) w.violations.push(`FIFO: ${id} got ${m.id} after seq ${prev}`);
			c.lastSeen.set(m.from, seqOf(m.id));
		}
		c.persisted.add(m.id);
		c.pendingAck.add(m.id);
		return true;
	},
	ack(w, pick) {
		const id = pick([...w.clients.keys()].filter((id) => w.brokerUp && agent(w, id)?.connected && w.clients.get(id)!.pendingAck.size > 0));
		if (!id) return false;
		const c = w.clients.get(id)!;
		const mid = pick([...c.pendingAck])!;
		if (!c.persisted.has(mid)) w.violations.push(`acked before persisted: ${id} ${mid}`);
		c.pendingAck.delete(mid);
		run(w, { type: "ack", id, msgId: mid });
		return true;
	},
	exit(w, pick) {
		const id = pick(Object.keys(w.st.agents).filter((id) => id !== ROOT && canAct(w, id)));
		if (!id) return false;
		const c = w.clients.get(id)!;
		c.inflight.push({ type: "exit", now: w.now, from: id, seq: c.nextSeq++, result: "r", truncated: false });
		return true;
	},
	kill(w, pick) {
		const p = pick(Object.keys(w.st.agents).filter((id) => canAct(w, id)));
		const t = pick(Object.keys(w.st.agents).filter((id) => agent(w, id).parent === p));
		if (!p || !t) return false;
		const c = w.clients.get(p)!;
		c.inflight.push({ type: "kill", now: w.now, from: p, seq: c.nextSeq++, target: t });
		return true;
	},
	// A terminate/exit makes the process end on its own.
	processEnds(w, pick) {
		const id = pick([...w.clients.keys()].filter((id) => w.clients.get(id)!.procAlive && ["exiting", "killing"].includes(agent(w, id)?.status)));
		if (!id) return false;
		stopProcess(w.clients.get(id)!);
		if (w.brokerUp && agent(w, id).connected) run(w, { type: "disconnect", now: w.now, id, conn: agent(w, id).conn });
		return true;
	},
	procExitReported(w, pick) {
		const id = pick([...w.clients.keys()].filter((id) => w.brokerUp && w.clients.get(id)!.exitPending));
		if (!id) return false;
		w.clients.get(id)!.exitPending = false;
		run(w, { type: "procExit", now: w.now, id, inc: agent(w, id).inc, code: 0, signal: null });
		return true;
	},
	tick(w, pick) {
		if (!w.brokerUp) return false;
		w.now += pick([1000, 2000, 5000, 5000, 20_000, 70_000])!;
		run(w, { type: "tick", now: w.now });
		return true;
	},
	processCrash(w, pick) {
		if (w.faults >= MAX_FAULTS) return false;
		const id = pick([...w.clients.keys()].filter((id) => id !== ROOT && w.clients.get(id)!.procAlive));
		if (!id) return false;
		w.faults++;
		stopProcess(w.clients.get(id)!);
		if (w.brokerUp && agent(w, id)?.connected) run(w, { type: "disconnect", now: w.now, id, conn: agent(w, id).conn });
		return true;
	},
	reload(w, pick) {
		if (w.faults >= MAX_FAULTS) return false;
		const id = pick([...w.clients.keys()].filter((id) => w.clients.get(id)!.procAlive));
		if (!id) return false;
		w.faults++;
		const c = w.clients.get(id)!;
		c.inflight = [];
		c.fetched = [];
		c.pendingAck = new Set();
		c.nextSeq = 1;
		if (w.brokerUp && agent(w, id)?.connected) run(w, { type: "disconnect", now: w.now, id, conn: agent(w, id).conn });
		return true;
	},
	brokerCrash(w) {
		if (w.faults >= MAX_FAULTS || !w.brokerUp) return false;
		w.faults++;
		// D2: replaying the log reproduces the live state exactly.
		assert.deepEqual(replay(initial("p", LIMITS, 0), w.log), w.st, "replay must equal the live state");
		w.brokerUp = false;
		return true;
	},
	brokerRestart(w) {
		if (w.brokerUp) return false;
		w.brokerUp = true;
		w.st = replay(initial("p", LIMITS, 0), w.log); // a fresh broker only has the log
		run(w, { type: "recover", now: w.now, downtimeMs: 0 });
		return true;
	},
};

// ---------------------------------------------------------------- invariants (the model's)

function checkInvariants(w: World) {
	const st = w.st;
	assert.deepEqual(w.violations, [], "client-side violations");
	for (const [key, n] of w.downEffects) assert.ok(n <= 1, `INV-2: ${key} went down ${n} times`);
	for (const a of Object.values(st.agents)) {
		if (a.status === "down") assert.equal(w.downEffects.get(`${a.id}:${a.inc}`), 1, `INV-2: ${a.id} down without exactly one DOWN`);
		const parent = a.parent ? st.agents[a.parent] : undefined;
		if (parent?.status === "down") assert.ok(!["starting", "live", "disconnected"].includes(a.status), `INV-1: ${a.id} active under a down parent`);
		assert.ok(a.depth <= LIMITS.maxDepth, "INV-5: depth");
		if (Object.keys(st.leases[a.id] ?? {}).length > 0) assert.ok(a.connected, `lease without connection: ${a.id}`);
	}
	assert.ok(st.agents[ROOT].spawns <= LIMITS.maxSpawns, "INV-5: spawns");
	for (const a of Object.values(st.agents)) {
		const parentDowns = (st.mailbox[a.id] ?? []).filter((m) => m.kind === "down").map((m) => JSON.parse(m.body).id + ":" + JSON.parse(m.body).inc);
		assert.equal(new Set(parentDowns).size, parentDowns.length, "INV-2: duplicate DOWN in a mailbox");
	}
	// INV-3 at-least-once: every message the sender saw accepted is still queued or consumed.
	for (const [msgId, to] of w.accepted) {
		const queued = (st.mailbox[to] ?? []).some((m) => m.id === msgId);
		const consumed = w.clients.get(to)?.persisted.has(msgId) ?? false;
		assert.ok(queued || consumed, `INV-3: ${msgId} to ${to} lost`);
	}
}

function simulate(seed: number, steps: number) {
	const rand = prng(seed);
	const pick = <T>(xs: T[]): T | undefined => (xs.length ? xs[Math.floor(rand() * xs.length)] : undefined);
	const w = world();
	// Weighted choice: the message flow often, faults rarely, so traces reach deep paths.
	const weight: Record<string, number> = { tick: 2, reload: 1, brokerCrash: 1, brokerRestart: 3, processCrash: 1, kill: 1, exit: 2 };
	const names = Object.keys(actions).flatMap((n) => Array(weight[n] ?? 6).fill(n) as string[]);
	const fired: Record<string, number> = {};
	for (let i = 0; i < steps; i++) {
		const name = pick(names)!;
		if (actions[name](w, pick)) fired[name] = (fired[name] ?? 0) + 1;
		checkInvariants(w);
	}
	return { w, fired };
}

test("Tree satisfies the model's invariants over random executions (3k seeds × 150 steps)", () => {
	const coverage: Record<string, number> = {};
	let redelivered = 0;
	let downs = 0;
	for (let seed = 1; seed <= 3000; seed++) {
		try {
			const { w, fired } = simulate(seed, 150);
			for (const [k, v] of Object.entries(fired)) coverage[k] = (coverage[k] ?? 0) + v;
			downs += [...w.downEffects.values()].length;
			redelivered += [...w.clients.values()].filter((c) => [...c.pendingAck].some((id) => c.persisted.has(id))).length;
		} catch (err) {
			(err as Error).message = `seed ${seed}: ${(err as Error).message}`;
			throw err;
		}
	}
	// Reachability witnesses: the simulation actually exercised the interesting paths.
	if (process.env.COVERAGE) console.log(coverage, { downs, redelivered });
	for (const a of Object.keys(actions)) assert.ok((coverage[a] ?? 0) > 50, `action ${a} rarely enabled: ${coverage[a] ?? 0}`);
	assert.ok(downs > 1000, `few DOWNs: ${downs}`);
	assert.ok(redelivered > 0, "no redelivery path reached");
});

test("seeded run is reproducible", () => {
	const a = simulate(42, 80).w.log;
	const b = simulate(42, 80).w.log;
	assert.deepEqual(a, b);
});
