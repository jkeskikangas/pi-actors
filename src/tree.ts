// Tree: the pure reducer that owns all routing state of one agent tree (design D2, D15).
//
// Every reducer case mirrors an action of model/pi_actors.qnt. Time enters only through the
// `now` field of events; facts only the shell can know (does this pid belong to the agent, is
// this process gone) arrive as event fields. `recover` is applied after replaying the log.

import {
	byteLength,
	type Context,
	DEFAULT_LIMITS,
	type ErrorCode,
	LIMITS,
	type Limits,
	type Message,
	type MessageKind,
	type Placement,
	type Response,
	TIMING,
} from "./protocol.ts";

export type Status = "starting" | "live" | "disconnected" | "exiting" | "killing" | "down";

export interface SpawnRequest {
	name?: string;
	task: string;
	model?: string;
	thinking?: string;
	context: Context;
	cwd?: string;
	placement: Placement;
	limits?: Partial<Limits>;
	timeoutS?: number;
	resume?: string;
}

export interface Agent {
	id: string;
	parent: string | null;
	depth: number;
	inc: number;
	status: Status;
	connected: boolean;
	/** Connection generation; frames from an older generation are ignored. */
	conn: number;
	procStarted: boolean;
	procGone: boolean;
	pid?: number;
	sessionId?: string;
	sessionFile?: string;
	spec?: SpawnRequest;
	limits: Limits;
	/** Spawns admitted in this agent's subtree (counted at every ancestor). */
	spawns: number;
	resumes: number;
	/** Deadline of the current status (starting, disconnected, exiting, killing). */
	deadline?: number;
	killStart?: number;
	killStep?: 0 | 1 | 2;
	/** Reason recorded when `down` is reached through killing or exiting. */
	pendingReason?: string;
	exitResult?: { result: string; truncated: boolean; error: boolean };
	timeoutAt?: number;
	/** Exempt obligations held for this agent as a receiver (calls it made, children it spawned) plus queued exempt messages. */
	reserve: number;
	reason?: string;
}

export interface PendingCall {
	caller: string;
	target: string;
	deadline: number;
}

export interface TreeState {
	treeId: string;
	agents: Record<string, Agent>;
	mailbox: Record<string, Message[]>;
	/** msgId -> fetchId, per receiver. Volatile: cleared by `recover`. */
	leases: Record<string, Record<string, string>>;
	/** Per sender incarnation ("id:inc"): last applied seq and cached responses. */
	seq: Record<string, { last: number; cache: Record<number, Response> }>;
	calls: Record<string, PendingCall>;
	brokerMsgs: number;
}

export type Event =
	| { type: "hello"; now: number; id: string; inc: number; pid: number; sessionId?: string; sessionFile?: string; ownsPid: boolean; recordedPidAlive?: boolean }
	| { type: "disconnect"; now: number; id: string; conn: number }
	| { type: "spawn"; now: number; from: string; seq: number; req: SpawnRequest; resumeProcGone?: boolean }
	| { type: "send"; now: number; from: string; seq: number; to: string; kind: Exclude<MessageKind, "down">; body: string; tag?: string; ref?: string; urgent?: boolean; timeoutS?: number }
	| { type: "answer"; now: number; from: string; seq: number; ref: string; body: string }
	| { type: "exit"; now: number; from: string; seq: number; result: string; truncated: boolean; error?: boolean }
	| { type: "kill"; now: number; from: string; seq: number; target: string }
	| { type: "fetch"; id: string; fetchId: string; kind?: MessageKind; from?: string; tag?: string; ref?: string }
	| { type: "ack"; id: string; msgId: string }
	| { type: "release"; id: string; msgId: string }
	| { type: "procStart"; id: string; inc: number; pid: number }
	| { type: "procExit"; now: number; id: string; inc: number; code: number | null; signal: string | null }
	| { type: "tick"; now: number }
	| { type: "slept"; ms: number }
	/** Applied and logged once after every broker restart (replay + recover must itself be replayable). */
	| { type: "recover"; now: number; downtimeMs: number }
	/** `/actors stop`: every agent, the root included, is killed. */
	| { type: "stop"; now: number };

export type Effect =
	| { type: "respond"; to: string; seq: number; response: Response }
	| { type: "welcome"; to: string; lastSeq: number; mailbox: number }
	| { type: "reject"; to: string; reason: string }
	| { type: "hold"; to: string }
	| { type: "superseded"; id: string; conn: number }
	| { type: "fetched"; to: string; fetchId: string; message: Message | null }
	| { type: "notify"; id: string; urgent: boolean }
	| { type: "start"; id: string; inc: number; spec: SpawnRequest; parentSessionFile?: string; resumeSessionFile?: string }
	| { type: "terminate"; id: string; reason: string }
	| { type: "signal"; id: string; sig: "TERM" | "KILL" }
	| { type: "down"; id: string; inc: number; reason: string };

export interface Result {
	state: TreeState;
	effects: Effect[];
}

export const HUMAN = "human";
export const ROOT = "root";

const ACTIVE: ReadonlySet<Status> = new Set(["starting", "live", "disconnected"]);
const isActive = (a: Agent | undefined) => !!a && ACTIVE.has(a.status);
const isExempt = (k: MessageKind) => k === "down" || k === "reply";

export function initial(treeId: string, limits: Limits = DEFAULT_LIMITS, now = 0): TreeState {
	const root: Agent = {
		id: ROOT, parent: null, depth: 0, inc: 1, status: "disconnected", connected: false, conn: 0,
		procStarted: true, procGone: false, limits: { ...limits }, spawns: 0, resumes: 0, reserve: 0,
		deadline: now + TIMING.rootGraceMs,
	};
	return { treeId, agents: { [ROOT]: root }, mailbox: { [ROOT]: [] }, leases: { [ROOT]: {} }, seq: {}, calls: {}, brokerMsgs: 0 };
}

/** Structural copy so `apply` never mutates its input (the log replays from the same values). */
function clone(state: TreeState): TreeState {
	return structuredClone(state);
}

export function apply(input: TreeState, ev: Event): Result {
	const st = clone(input);
	const fx: Effect[] = [];
	switch (ev.type) {
		case "hello":
			hello(st, ev, fx);
			break;
		case "disconnect": {
			const a = st.agents[ev.id];
			if (a && a.connected && a.conn === ev.conn) disconnect(st, a, ev.now);
			break;
		}
		case "spawn":
		case "send":
		case "answer":
		case "exit":
		case "kill":
			sequenced(st, ev, fx);
			break;
		case "fetch":
			fetch(st, ev, fx);
			break;
		case "ack":
			ack(st, ev.id, ev.msgId);
			break;
		case "release":
			delete st.leases[ev.id]?.[ev.msgId];
			break;
		case "procStart": {
			const a = st.agents[ev.id];
			if (a && a.inc === ev.inc && a.status !== "down") {
				a.procStarted = true;
				a.pid = ev.pid;
			}
			break;
		}
		case "procExit":
			procExit(st, ev, fx);
			break;
		case "tick":
			tick(st, ev.now, fx);
			break;
		case "slept":
			slept(st, ev.ms);
			break;
		case "recover":
			recoverInPlace(st, ev.now, ev.downtimeMs);
			break;
		case "stop":
			for (const a of Object.values(st.agents)) if (a.id !== ROOT) beginKill(a, ev.now, "killed:tree_stopped", fx);
			goDown(st, st.agents[ROOT], ev.now, "stopped", fx);
			break;
	}
	return { state: st, effects: fx };
}

/**
 * After replay (D2): leases are gone, deadlines shift by the downtime, live agents become
 * disconnected, and orphans are swept. The broker applies this as a logged `recover` event,
 * so a later replay reproduces it.
 */
export function recover(input: TreeState, now: number, downtimeMs = 0): TreeState {
	return apply(input, { type: "recover", now, downtimeMs }).state;
}

function recoverInPlace(st: TreeState, now: number, downtimeMs: number) {
	for (const id of Object.keys(st.leases)) st.leases[id] = {};
	slept(st, downtimeMs);
	for (const a of Object.values(st.agents)) {
		a.connected = false;
		if (a.status === "live") {
			a.status = "disconnected";
			a.deadline = now + grace(a);
		}
	}
	for (const a of Object.values(st.agents)) {
		const p = a.parent ? st.agents[a.parent] : undefined;
		if (p?.status === "down" && isActive(a)) beginKill(a, now, "killed:parent_down", []);
	}
}

// ---------------------------------------------------------------- identity

function hello(st: TreeState, ev: Extract<Event, { type: "hello" }>, fx: Effect[]) {
	const a = st.agents[ev.id];
	if (!a) return fx.push({ type: "reject", to: ev.id, reason: "unknown" });
	if (a.status === "down") return fx.push({ type: "reject", to: ev.id, reason: "down" });
	if (ev.inc !== a.inc) return fx.push({ type: "reject", to: ev.id, reason: "stale_incarnation" });
	if (a.id === ROOT) {
		const reloadOrFirst = a.pid === undefined || a.pid === ev.pid;
		const takeover = a.sessionId !== undefined && a.sessionId === ev.sessionId && ev.recordedPidAlive === false;
		if (!reloadOrFirst && !takeover) return fx.push({ type: "reject", to: ev.id, reason: "root_fence" });
		if (a.sessionId === undefined) a.sessionId = ev.sessionId;
	} else {
		if (!a.procStarted && a.spec?.placement === "headless") return fx.push({ type: "hold", to: ev.id });
		if (!ev.ownsPid) return fx.push({ type: "reject", to: ev.id, reason: "pid_mismatch" });
		if (a.pid !== undefined && a.spec?.placement === "pane" && a.pid !== ev.pid) {
			return fx.push({ type: "reject", to: ev.id, reason: "pid_mismatch" });
		}
	}
	if (a.connected) fx.push({ type: "superseded", id: a.id, conn: a.conn });
	a.conn += 1;
	a.connected = true;
	a.pid = ev.pid;
	if (ev.sessionFile) a.sessionFile = ev.sessionFile;
	if (a.status !== "exiting" && a.status !== "killing") {
		a.status = "live";
		a.deadline = undefined;
	}
	st.leases[a.id] = {};
	const key = `${a.id}:${a.inc}`;
	fx.push({ type: "welcome", to: a.id, lastSeq: st.seq[key]?.last ?? 0, mailbox: st.mailbox[a.id]?.length ?? 0 });
}

function disconnect(st: TreeState, a: Agent, now: number) {
	a.connected = false;
	st.leases[a.id] = {};
	if (a.status === "live") {
		a.status = "disconnected";
		a.deadline = now + grace(a);
	}
}

const grace = (a: Agent) => (a.id === ROOT ? TIMING.rootGraceMs : TIMING.childGraceMs);

// ---------------------------------------------------------------- sequenced frames (idempotent)

type SeqEvent = Extract<Event, { type: "spawn" | "send" | "answer" | "exit" | "kill" }>;

function sequenced(st: TreeState, ev: SeqEvent, fx: Effect[]) {
	const sender = st.agents[ev.from];
	const key = `${ev.from}:${sender?.inc ?? 0}`;
	const track = (st.seq[key] ??= { last: 0, cache: {} });
	if (ev.seq <= track.last) {
		const cached = track.cache[ev.seq];
		fx.push({ type: "respond", to: ev.from, seq: ev.seq, response: cached ?? { ok: false, error: "seq_gap", detail: "expired" } });
		return;
	}
	if (ev.seq > track.last + 1) {
		fx.push({ type: "respond", to: ev.from, seq: ev.seq, response: { ok: false, error: "seq_gap", detail: `expected ${track.last + 1}` } });
		return;
	}
	const response = handle(st, ev, fx);
	track.last = ev.seq;
	track.cache[ev.seq] = response;
	delete track.cache[ev.seq - LIMITS.idempotencyWindow];
	fx.push({ type: "respond", to: ev.from, seq: ev.seq, response });
}

const fail = (error: ErrorCode, detail?: string): Response => ({ ok: false, error, detail });

function handle(st: TreeState, ev: SeqEvent, fx: Effect[]): Response {
	const sender = st.agents[ev.from];
	if (!sender || (ev.type !== "exit" && sender.status !== "live")) return fail("not_live");
	switch (ev.type) {
		case "spawn":
			return spawn(st, sender, ev, fx);
		case "send":
			return send(st, sender, ev, fx);
		case "answer":
			return answer(st, sender, ev, fx);
		case "exit":
			return exit(st, sender, ev, fx);
		case "kill":
			return kill(st, sender, ev, fx);
	}
}

// ---------------------------------------------------------------- spawn / limits

function ancestors(st: TreeState, a: Agent): Agent[] {
	const out: Agent[] = [];
	for (let cur: Agent | undefined = a; cur; cur = cur.parent ? st.agents[cur.parent] : undefined) out.push(cur);
	return out;
}

function spawn(st: TreeState, parent: Agent, ev: Extract<Event, { type: "spawn" }>, fx: Effect[]): Response {
	const req = ev.req;
	if (byteLength(req.task) > LIMITS.frameBytes) return fail("too_large");
	const chain = ancestors(st, parent);
	// Limits are absolute and only tighten down the tree, so the parent's depth limit is the effective one.
	if (!req.resume && parent.depth + 1 > parent.limits.maxDepth) return fail("limit_depth");
	if (chain.some((x) => x.spawns >= x.limits.maxSpawns)) return fail("budget_exhausted");
	if (parent.reserve >= LIMITS.reserve) return fail("mailbox_full", "no DOWN reserve left");

	let child: Agent;
	if (req.resume) {
		const old = st.agents[req.resume];
		if (!old || old.parent !== parent.id) return fail("not_authorized");
		if (old.status !== "down" || !(old.procGone || ev.resumeProcGone)) return fail("bad_request", "process not confirmed gone");
		if (old.resumes >= LIMITS.maxResumes) return fail("budget_exhausted", "resume limit");
		child = old;
		child.inc += 1;
		child.resumes += 1;
		child.reason = undefined;
		child.exitResult = undefined;
		child.pendingReason = undefined;
	} else {
		const depth = parent.depth + 1;
		const base = req.name ? `${parent.id === ROOT ? "" : `${parent.id}.`}${sanitize(req.name)}` : "";
		const id = uniqueId(st, base || `${parent.id === ROOT ? "" : `${parent.id}.`}a${Object.keys(st.agents).length}`);
		child = {
			id, parent: parent.id, depth, inc: 1, status: "starting", connected: false, conn: 0,
			procStarted: false, procGone: false,
			limits: {
				maxDepth: Math.min(parent.limits.maxDepth, req.limits?.maxDepth ?? Number.POSITIVE_INFINITY),
				maxSpawns: Math.min(parent.limits.maxSpawns, req.limits?.maxSpawns ?? Number.POSITIVE_INFINITY),
			},
			spawns: 0, resumes: 0, reserve: 0,
		};
		st.agents[id] = child;
		st.mailbox[id] = [];
		st.leases[id] = {};
	}
	child.status = "starting";
	child.connected = false;
	child.procStarted = false;
	child.procGone = false;
	child.pid = undefined;
	child.spec = { ...req, resume: undefined };
	child.deadline = ev.now + TIMING.startMs;
	child.timeoutAt = req.timeoutS ? ev.now + req.timeoutS * 1000 : undefined;
	for (const x of chain) x.spawns += 1;
	parent.reserve += 1;
	enqueue(st, { id: brokerId(st), from: parent.id, to: child.id, kind: "mail", body: req.task, tag: "task" });
	fx.push({
		type: "start", id: child.id, inc: child.inc, spec: child.spec,
		parentSessionFile: req.context === "fork" ? parent.sessionFile : undefined,
		resumeSessionFile: req.resume ? child.sessionFile : undefined,
	});
	return { ok: true, type: "spawned", id: child.id, inc: child.inc };
}

const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 32) || "a";
function uniqueId(st: TreeState, base: string): string {
	if (!st.agents[base] && base !== HUMAN && base !== ROOT) return base;
	for (let n = 2; ; n++) if (!st.agents[`${base}-${n}`]) return `${base}-${n}`;
}

// ---------------------------------------------------------------- messages

const brokerId = (st: TreeState) => `broker:${++st.brokerMsgs}`;

function mailCounts(st: TreeState, id: string) {
	const box = st.mailbox[id] ?? [];
	const ordinary = box.filter((m) => !isExempt(m.kind));
	return { count: ordinary.length, bytes: ordinary.reduce((n, m) => n + byteLength(m.body), 0) };
}

function enqueue(st: TreeState, m: Message): void {
	(st.mailbox[m.to] ??= []).push(m);
}

function send(st: TreeState, sender: Agent, ev: Extract<Event, { type: "send" }>, fx: Effect[]): Response {
	if (byteLength(ev.body) > LIMITS.frameBytes) return fail("too_large");
	const msgId = `${sender.id}:${sender.inc}:${ev.seq}`;
	if (ev.kind === "reply") {
		const call = ev.ref ? st.calls[ev.ref] : undefined;
		if (!call) return fail("stale_ref");
		if (call.target !== sender.id) return fail("not_authorized");
		deliverReply(st, ev.ref!, { id: msgId, from: sender.id, to: call.caller, kind: "reply", body: ev.body, ref: ev.ref }, fx);
		return { ok: true, type: "accepted", msgId };
	}
	if (ev.to === sender.id) return fail("bad_request", "cannot send to self");
	const target = st.agents[ev.to];
	const toHuman = ev.to === HUMAN;
	if (!toHuman && !target) return fail("unknown_target");
	if (toHuman && ev.kind !== "call") return fail("bad_request", "human accepts call only");
	if (target && (target.status === "down" || target.status === "killing" || target.status === "exiting")) {
		return fail("target_down", target.reason ?? target.status);
	}
	const box = mailCounts(st, ev.to);
	if (box.count >= LIMITS.mailboxCount || box.bytes + byteLength(ev.body) > LIMITS.mailboxBytes) return fail("mailbox_full");
	if (ev.kind === "call") {
		if (sender.reserve >= LIMITS.reserve) return fail("reply_reserve_full");
		sender.reserve += 1;
		st.calls[msgId] = { caller: sender.id, target: ev.to, deadline: ev.now + (ev.timeoutS ?? 600) * 1000 };
	}
	enqueue(st, { id: msgId, from: sender.id, to: ev.to, kind: ev.kind, body: ev.body, tag: ev.tag, ref: ev.kind === "call" ? msgId : undefined, urgent: ev.urgent });
	if (!toHuman) fx.push({ type: "notify", id: ev.to, urgent: !!ev.urgent });
	else fx.push({ type: "notify", id: ROOT, urgent: true });
	return { ok: true, type: "accepted", msgId };
}

/** A reply (or a broker-made error reply) consumes the caller's held reserve slot. */
function deliverReply(st: TreeState, ref: string, m: Message, fx: Effect[]) {
	const call = st.calls[ref];
	if (!call) return;
	delete st.calls[ref];
	const caller = st.agents[call.caller];
	if (!caller || caller.status === "down") {
		if (caller) caller.reserve = Math.max(0, caller.reserve - 1);
		return;
	}
	enqueue(st, m); // the reserve slot moves from "obligation" to "queued exempt message"
	fx.push({ type: "notify", id: caller.id, urgent: false });
}

function answer(st: TreeState, sender: Agent, ev: Extract<Event, { type: "answer" }>, fx: Effect[]): Response {
	const call = st.calls[ev.ref];
	if (!call || call.target !== HUMAN) return fail("stale_ref");
	if (sender.id !== ROOT && sender.id !== call.caller) return fail("not_authorized");
	const msgId = `${sender.id}:${sender.inc}:${ev.seq}`;
	// The human's question is consumed with its answer.
	st.mailbox[HUMAN] = (st.mailbox[HUMAN] ?? []).filter((m) => m.ref !== ev.ref);
	deliverReply(st, ev.ref, { id: msgId, from: HUMAN, to: call.caller, kind: "reply", body: ev.body, ref: ev.ref }, fx);
	return { ok: true, type: "accepted", msgId };
}

function matches(m: Message, f: Extract<Event, { type: "fetch" }>): boolean {
	if (f.ref !== undefined) return m.ref === f.ref && m.kind === "reply";
	if (f.kind !== undefined ? m.kind !== f.kind : m.kind === "reply") return false;
	if (f.from !== undefined && m.from !== f.from) return false;
	if (f.tag !== undefined && m.tag !== f.tag) return false;
	return true;
}

function fetch(st: TreeState, ev: Extract<Event, { type: "fetch" }>, fx: Effect[]) {
	const a = st.agents[ev.id];
	const box = ev.id === HUMAN ? st.mailbox[HUMAN] ?? [] : st.mailbox[ev.id] ?? [];
	const leases = (st.leases[ev.id] ??= {});
	const reader = ev.id === HUMAN ? st.agents[ROOT] : a;
	if (!reader?.connected) return fx.push({ type: "fetched", to: ev.id, fetchId: ev.fetchId, message: null });
	const m = box.find((x) => !leases[x.id] && matches(x, ev)) ?? null;
	if (m && ev.id !== HUMAN) leases[m.id] = ev.fetchId;
	fx.push({ type: "fetched", to: ev.id, fetchId: ev.fetchId, message: m });
}

function ack(st: TreeState, id: string, msgId: string) {
	const box = st.mailbox[id];
	if (!box) return;
	const i = box.findIndex((m) => m.id === msgId);
	if (i < 0) return;
	const [m] = box.splice(i, 1);
	delete st.leases[id]?.[msgId];
	const a = st.agents[id];
	if (a && isExempt(m.kind)) a.reserve = Math.max(0, a.reserve - 1);
}

// ---------------------------------------------------------------- lifecycle

function exit(st: TreeState, a: Agent, ev: Extract<Event, { type: "exit" }>, fx: Effect[]): Response {
	if (a.id === ROOT) return fail("bad_request", "the root does not exit; use /actors stop");
	if (!isActive(a)) return fail("not_live");
	a.status = "exiting";
	a.exitResult = { result: ev.result.slice(0, LIMITS.frameBytes), truncated: ev.truncated || ev.result.length > LIMITS.frameBytes, error: !!ev.error };
	a.deadline = ev.now + TIMING.exitingMs;
	fx.push({ type: "terminate", id: a.id, reason: "exit" });
	return { ok: true, type: "done" };
}

function kill(st: TreeState, sender: Agent, ev: Extract<Event, { type: "kill" }>, fx: Effect[]): Response {
	const t = st.agents[ev.target];
	if (!t) return fail("unknown_target");
	const isAncestor = ancestors(st, t).slice(1).some((x) => x.id === sender.id);
	if (!isAncestor) return fail("not_authorized");
	if (t.status === "exiting" || t.status === "down" || t.status === "killing") return { ok: true, type: "done" };
	beginKill(t, ev.now, "killed", fx);
	return { ok: true, type: "done" };
}

function beginKill(a: Agent, now: number, reason: string, fx: Effect[]) {
	if (!isActive(a)) return;
	a.status = "killing";
	a.pendingReason = reason;
	a.killStart = now;
	a.killStep = 0;
	a.deadline = now + TIMING.killGiveUpMs;
	fx.push({ type: "terminate", id: a.id, reason });
}

function procExit(st: TreeState, ev: Extract<Event, { type: "procExit" }>, fx: Effect[]) {
	const a = st.agents[ev.id];
	if (!a || a.inc !== ev.inc) return;
	a.procGone = true;
	a.connected = false;
	if (a.status === "down") return;
	let reason: string;
	if (a.status === "exiting") reason = a.exitResult?.error ? "error" : "normal";
	else if (a.status === "killing") reason = a.pendingReason ?? "killed";
	else reason = `error:crashed(${ev.code ?? ev.signal ?? "?"})`;
	goDown(st, a, ev.now, reason, fx);
}

/** Entering `down`: exactly one DOWN, calls resolved, the link rule applied (INV-1, INV-2). */
function goDown(st: TreeState, a: Agent, now: number, reason: string, fx: Effect[]) {
	if (a.status === "down") return;
	a.status = "down";
	a.reason = reason;
	a.connected = false;
	a.deadline = undefined;
	a.timeoutAt = undefined;
	st.leases[a.id] = {};
	fx.push({ type: "down", id: a.id, inc: a.inc, reason });
	const parent = a.parent ? st.agents[a.parent] : undefined;
	if (parent) {
		const r = a.exitResult;
		enqueue(st, {
			id: brokerId(st), from: "broker", to: parent.id, kind: "down",
			body: JSON.stringify({ id: a.id, inc: a.inc, reason, result: r?.result ?? null, truncated: r?.truncated ?? false }),
		});
		fx.push({ type: "notify", id: parent.id, urgent: false });
	}
	// Calls this agent was asked: fail them for their callers.
	for (const [ref, c] of Object.entries(st.calls)) {
		if (c.target === a.id) deliverReply(st, ref, { id: brokerId(st), from: "broker", to: c.caller, kind: "reply", body: JSON.stringify({ error: `target_down:${reason}` }), ref }, fx);
	}
	// Calls this agent made: nobody will read the reply.
	for (const [ref, c] of Object.entries(st.calls)) if (c.caller === a.id) delete st.calls[ref];
	// Calls the dead root made to the human, and human calls once the root is gone.
	if (a.id === ROOT) {
		for (const [ref, c] of Object.entries(st.calls)) {
			if (c.target === HUMAN) deliverReply(st, ref, { id: brokerId(st), from: "broker", to: c.caller, kind: "reply", body: JSON.stringify({ error: "target_down:root_down" }), ref }, fx);
		}
	}
	for (const c of Object.values(st.agents)) {
		if (c.parent === a.id && isActive(c)) beginKill(c, now, "killed:parent_down", fx);
	}
}

function tick(st: TreeState, now: number, fx: Effect[]) {
	for (const a of Object.values(st.agents)) {
		if (a.status === "down") continue;
		if (a.timeoutAt !== undefined && now >= a.timeoutAt && isActive(a)) {
			beginKill(a, now, "timeout", fx);
			continue;
		}
		if (a.deadline === undefined || now < a.deadline) {
			if (a.status === "killing" && a.killStart !== undefined) {
				if (a.killStep === 0 && now >= a.killStart + TIMING.killTermMs) {
					a.killStep = 1;
					fx.push({ type: "signal", id: a.id, sig: "TERM" });
				} else if (a.killStep === 1 && now >= a.killStart + TIMING.killKillMs) {
					a.killStep = 2;
					fx.push({ type: "signal", id: a.id, sig: "KILL" });
				}
			}
			continue;
		}
		switch (a.status) {
			case "starting":
				beginKill(a, now, "error:start_timeout", fx);
				break;
			case "disconnected":
				beginKill(a, now, "lost", fx);
				break;
			case "exiting":
				fx.push({ type: "signal", id: a.id, sig: "KILL" });
				goDown(st, a, now, a.exitResult?.error ? "error" : "normal", fx);
				break;
			case "killing":
				fx.push({ type: "signal", id: a.id, sig: "KILL" });
				goDown(st, a, now, `${a.pendingReason ?? "killed"}:unconfirmed`, fx);
				break;
			case "live":
				break;
		}
	}
	for (const [ref, c] of Object.entries(st.calls)) {
		if (now >= c.deadline) deliverReply(st, ref, { id: brokerId(st), from: "broker", to: c.caller, kind: "reply", body: JSON.stringify({ error: "timeout" }), ref }, fx);
	}
}

/** The machine slept: active-time deadlines move by the slept duration (design "Time and sleep"). */
function slept(st: TreeState, ms: number) {
	if (ms <= 0) return;
	for (const a of Object.values(st.agents)) {
		if (a.deadline !== undefined) a.deadline += ms;
		if (a.timeoutAt !== undefined) a.timeoutAt += ms;
		if (a.killStart !== undefined) a.killStart += ms;
	}
	for (const c of Object.values(st.calls)) c.deadline += ms;
}

/** Rebuild state from the event log; effects are discarded (design D2: replay never re-executes). */
export function replay(start: TreeState, events: readonly Event[]): TreeState {
	let st = start;
	for (const ev of events) st = apply(st, ev).state;
	return st;
}

/** Earliest wall-clock time at which a `tick` would change something (undefined: nothing pending). */
export function nextDeadline(st: TreeState): number | undefined {
	let t: number | undefined;
	const consider = (x: number | undefined) => {
		if (x !== undefined && (t === undefined || x < t)) t = x;
	};
	for (const a of Object.values(st.agents)) {
		if (a.status === "down") continue;
		consider(a.deadline);
		if (isActive(a)) consider(a.timeoutAt);
		if (a.status === "killing" && a.killStart !== undefined) {
			consider(a.killStep === 0 ? a.killStart + TIMING.killTermMs : a.killStep === 1 ? a.killStart + TIMING.killKillMs : undefined);
		}
	}
	for (const c of Object.values(st.calls)) consider(c.deadline);
	return t;
}

/** True when every agent is down: the broker can compact and exit. */
export function finished(st: TreeState): boolean {
	return Object.values(st.agents).every((a) => a.status === "down");
}
