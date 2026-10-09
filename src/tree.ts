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
	paneId?: string;
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
	/** DOWN obligations held for this agent (children it spawned) plus its queued DOWN notices. */
	reserve: number;
	reason?: string;
}

export interface TreeState {
	treeId: string;
	agents: Record<string, Agent>;
	mailbox: Record<string, Message[]>;
	/** msgId -> fetchId, per receiver. Volatile: cleared by `recover`. */
	leases: Record<string, Record<string, string>>;
	/** Per sender incarnation ("id:inc"): last applied seq and cached responses. */
	seq: Record<string, { last: number; cache: Record<number, Response> }>;
	brokerMsgs: number;
	/** Ids removed by `forget`: never reused, so a lingering process can never claim a new agent's id. */
	forgotten: string[];
}

export type Event =
	| { type: "hello"; now: number; id: string; inc: number; pid: number; sessionId?: string; sessionFile?: string; ownsPid: boolean; recordedPidAlive?: boolean }
	| { type: "disconnect"; now: number; id: string; conn: number }
	| { type: "spawn"; now: number; from: string; seq: number; req: SpawnRequest; resumeProcGone?: boolean }
	| { type: "send"; now: number; from: string; seq: number; to: string; kind: Exclude<MessageKind, "down">; body: string; tag?: string; ref?: string; urgent?: boolean }
	| { type: "exit"; now: number; from: string; seq: number; result: string; truncated: boolean; error?: boolean }
	| { type: "kill"; now: number; from: string; seq: number; target: string }
	/** Remove an ended agent and its ended subtree from the tree (the panel's "clear"). */
	| { type: "forget"; now: number; from: string; seq: number; target: string }
	| { type: "fetch"; id: string; fetchId: string; kind?: MessageKind; from?: string; tag?: string; ref?: string; all?: boolean }
	| { type: "ack"; id: string; msgId: string }
	| { type: "release"; id: string; msgId: string }
	| { type: "procStart"; id: string; inc: number; pid: number }
	| { type: "procExit"; now: number; id: string; inc: number; code: number | null; signal: string | null }
	/** A pane child was placed: its pane id survives broker restarts (F5). */
	| { type: "placed"; id: string; inc: number; paneId: string }
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

export const ROOT = "root";

const ACTIVE: ReadonlySet<Status> = new Set(["starting", "live", "disconnected"]);
const isActive = (a: Agent | undefined) => !!a && ACTIVE.has(a.status);
const isExempt = (k: MessageKind) => k === "down";

export function initial(treeId: string, limits: Limits = DEFAULT_LIMITS, now = 0): TreeState {
	const root: Agent = {
		id: ROOT, parent: null, depth: 0, inc: 1, status: "disconnected", connected: false, conn: 0,
		procStarted: true, procGone: false, limits: { ...limits }, spawns: 0, resumes: 0, reserve: 0,
		deadline: now + TIMING.rootGraceMs,
	};
	return { treeId, agents: { [ROOT]: root }, mailbox: { [ROOT]: [] }, leases: { [ROOT]: {} }, seq: {}, brokerMsgs: 0, forgotten: [] };
}

/** Structural copy so `apply` never mutates its input (the log replays from the same values). */
function clone(state: TreeState): TreeState {
	return structuredClone(state);
}

/**
 * Events the log writes without waiting for the disk: leases only, which `recover` clears
 * anyway, so a crash that loses a trailing run of them changes nothing a restart keeps
 * (test/tree.property.test.ts: brokerCrashLosingTail). Acks stay durable: pi does not fsync its
 * session, so after a machine crash a lost ack would redeliver a message whose consumption the
 * session lost too, and the agent would act on it twice.
 */
export const UNSYNCED_EVENTS: ReadonlySet<Event["type"]> = new Set(["fetch", "release"]);

export function apply(input: TreeState, ev: Event): Result {
	const st = clone(input);
	st.forgotten ??= []; // a snapshot written before `forget` existed
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
		case "exit":
		case "kill":
		case "forget":
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
		case "placed": {
			const a = st.agents[ev.id];
			if (a && a.inc === ev.inc) a.paneId = ev.paneId;
			break;
		}
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
		// The same process may have switched sessions (/new, /resume, /fork): the root now lives in
		// that session, so a later `pi --continue` of it may take over (N4).
		if (reloadOrFirst && ev.sessionId) a.sessionId = ev.sessionId;
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

type SeqEvent = Extract<Event, { type: "spawn" | "send" | "exit" | "kill" | "forget" }>;

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
		case "exit":
			return exit(st, sender, ev, fx);
		case "kill":
			return kill(st, sender, ev, fx);
		case "forget":
			return forget(st, sender, ev);
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
	const taken = (id: string) => !!st.agents[id] || id === ROOT || st.forgotten.includes(id);
	if (!taken(base)) return base;
	for (let n = 2; ; n++) if (!taken(`${base}-${n}`)) return `${base}-${n}`;
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
	if (ev.kind !== "mail") return fail("bad_request", "only mail can be sent");
	const msgId = `${sender.id}:${sender.inc}:${ev.seq}`;
	if (ev.to === sender.id) return fail("bad_request", "cannot send to self");
	const target = st.agents[ev.to];
	if (!target) return fail("unknown_target");
	if (target.status === "down" || target.status === "killing" || target.status === "exiting") {
		return fail("target_down", target.reason ?? target.status);
	}
	const box = mailCounts(st, ev.to);
	if (box.count >= LIMITS.mailboxCount || box.bytes + byteLength(ev.body) > LIMITS.mailboxBytes) return fail("mailbox_full");
	enqueue(st, { id: msgId, from: sender.id, to: ev.to, kind: "mail", body: ev.body, tag: ev.tag, ref: ev.ref, urgent: ev.urgent });
	fx.push({ type: "notify", id: ev.to, urgent: !!ev.urgent });
	return { ok: true, type: "accepted", msgId };
}

function matches(m: Message, f: Extract<Event, { type: "fetch" }>): boolean {
	if (f.all) return true; // push delivery takes everything
	if (f.ref !== undefined && m.ref !== f.ref) return false;
	if (f.kind !== undefined && m.kind !== f.kind) return false;
	if (f.from !== undefined && m.from !== f.from) return false;
	if (f.tag !== undefined && m.tag !== f.tag) return false;
	return true;
}

function fetch(st: TreeState, ev: Extract<Event, { type: "fetch" }>, fx: Effect[]) {
	const a = st.agents[ev.id];
	const box = st.mailbox[ev.id] ?? [];
	const leases = (st.leases[ev.id] ??= {});
	if (!a?.connected) return fx.push({ type: "fetched", to: ev.id, fetchId: ev.fetchId, message: null });
	const m = box.find((x) => !leases[x.id] && matches(x, ev)) ?? null;
	if (m) leases[m.id] = ev.fetchId;
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

function descendants(st: TreeState, id: string): Agent[] {
	const out: Agent[] = [];
	for (const a of Object.values(st.agents)) if (a.parent === id) out.push(a, ...descendants(st, a.id));
	return out;
}

/**
 * Only a whole ended subtree is forgotten, by its parent or once its parent has ended too:
 * nothing in it can still send, owe a DOWN or be resumed. Its ids are retired, never reused (a
 * process the kill did not confirm gone may live).
 */
function forget(st: TreeState, sender: Agent, ev: Extract<Event, { type: "forget" }>): Response {
	const t = st.agents[ev.target];
	if (!t) return fail("unknown_target");
	if (!ancestors(st, t).slice(1).some((x) => x.id === sender.id)) return fail("not_authorized");
	const gone = [t, ...descendants(st, t.id)];
	if (gone.some((a) => a.status !== "down")) return fail("bad_request", "still running");
	// A running parent may still resume or read about its child: only it may clear that child.
	const parent = t.parent ? st.agents[t.parent] : undefined;
	if (parent && parent.id !== sender.id && parent.status !== "down") return fail("bad_request", "its parent still runs");
	for (const a of gone) {
		delete st.agents[a.id];
		delete st.mailbox[a.id];
		delete st.leases[a.id];
		for (const key of Object.keys(st.seq)) if (key.slice(0, key.lastIndexOf(":")) === a.id) delete st.seq[key];
		st.forgotten.push(a.id);
	}
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
	else if (ev.signal === "start_failed") reason = "error:start_failed";
	else reason = `error:crashed(${ev.code ?? ev.signal ?? "?"})`;
	goDown(st, a, ev.now, reason, fx);
}

/** Entering `down`: exactly one DOWN and the link rule applied (INV-1, INV-2). */
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
}

/** The machine slept: active-time deadlines move by the slept duration (design "Time and sleep"). */
function slept(st: TreeState, ms: number) {
	if (ms <= 0) return;
	for (const a of Object.values(st.agents)) {
		if (a.deadline !== undefined) a.deadline += ms;
		if (a.timeoutAt !== undefined) a.timeoutAt += ms;
		if (a.killStart !== undefined) a.killStart += ms;
	}
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
	return t;
}

/** True when every agent is down: the broker can compact and exit. */
export function finished(st: TreeState): boolean {
	return Object.values(st.agents).every((a) => a.status === "down");
}
