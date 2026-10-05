// BrokerServer: the only writer of a tree's state. Socket frames become Tree events; every
// event is logged (fsync) before its effects run (design D1, D2, D4, D13).

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { closePane, herdrAvailable, listPanes, paneAgentName, paneForegroundGroup, startPane } from "../placement/pane.ts";
import { signalGroup, startHeadless } from "../placement/headless.ts";
import { decode, encode, PROTO, TIMING } from "../protocol.ts";
import { acquireLock, type Config, ensureDir, releaseLock } from "../runtime.ts";
import { apply, type Effect, type Event, finished, HUMAN, initial, nextDeadline, replay, ROOT, type SpawnRequest, type TreeState } from "../tree.ts";
import { EventLog } from "./log.ts";

type Role = "agent" | "keeper";

interface Conn {
	socket: Socket;
	role?: Role;
	id?: string;
	/** Tree connection generation (agents only). */
	gen?: number;
	inc?: number;
	lastSeen: number;
	buf: string;
}

export interface BrokerHandle {
	stop(): Promise<void>;
	readonly state: TreeState;
	readonly done: Promise<void>;
}

const SLEEP_GAP_MS = 5000;

export async function startBroker(dir: string, sock: string, config: Config): Promise<BrokerHandle> {
	ensureDir(dir);
	if (!acquireLock(dir)) throw new Error(`another broker holds ${join(dir, "broker.lock")}`);
	const { log, loaded } = EventLog.open(dir, config.treeId);
	let st = replay(loaded.snapshot ?? initial(config.treeId, config.limits, Date.now()), loaded.events);
	const conns = new Set<Conn>();
	const agentConn = new Map<string, Conn>();
	const keeperConn = new Map<string, Conn>();
	const panes = new Map<string, string>(); // agent id -> pane id
	const pendingHello = new Map<string, { conn: Conn; frame: HelloFrame }>();
	let resolveDone!: () => void;
	const done = new Promise<void>((r) => (resolveDone = r));
	let stopping = false;

	const logsDir = join(dir, "agents");
	ensureDir(logsDir);
	const sessionsDir = join(dir, "sessions");
	ensureDir(sessionsDir);

	const send = (c: Conn | undefined, frame: object) => {
		if (c && !c.socket.destroyed) c.socket.write(encode(frame));
	};

	// ------------------------------------------------------------ events and effects

	const run = (ev: Event, ctx?: Conn): Effect[] => {
		const r = apply(st, ev);
		st = r.state;
		log.append(ev, Date.now());
		for (const e of r.effects) perform(e, ctx);
		writeStatus();
		return r.effects;
	};

	const perform = (e: Effect, ctx?: Conn) => {
		switch (e.type) {
			case "welcome": {
				if (!ctx) return;
				const a = st.agents[e.to];
				ctx.id = e.to;
				ctx.gen = a.conn;
				ctx.inc = a.inc;
				agentConn.set(e.to, ctx);
				send(ctx, { t: "welcome", lastSeq: e.lastSeq, mailbox: e.mailbox, id: e.to, inc: a.inc, parent: a.parent, treeId: st.treeId });
				break;
			}
			case "reject":
				send(ctx, { t: "reject", reason: e.reason });
				ctx?.socket.end();
				break;
			case "hold":
				break; // re-applied when the Keeper's proc_start arrives
			case "superseded": {
				const old = agentConn.get(e.id);
				if (old && old !== ctx) {
					send(old, { t: "superseded" });
					old.id = undefined; // its close must not disconnect the new connection
					old.socket.end();
				}
				break;
			}
			case "respond":
				send(agentConn.get(e.to), { t: "resp", seq: e.seq, response: e.response });
				break;
			case "fetched":
				send(e.to === HUMAN ? agentConn.get(ROOT) : agentConn.get(e.to), { t: "fetched", fetchId: e.fetchId, message: e.message });
				break;
			case "notify":
				send(agentConn.get(e.id), { t: "mail", urgent: e.urgent, human: humanPending() });
				break;
			case "terminate":
				send(agentConn.get(e.id), { t: "terminate", reason: e.reason });
				break;
			case "signal": {
				const k = keeperConn.get(e.id);
				const a = st.agents[e.id];
				if (k) send(k, { t: "signal", sig: e.sig });
				else if (a?.pid && a.spec?.placement === "headless") signalGroup(a.pid, e.sig);
				else if (panes.has(e.id) && e.sig === "KILL") void closePane(panes.get(e.id)!);
				break;
			}
			case "start":
				void start(e.id, e.inc, e.spec, e.parentSessionFile, e.resumeSessionFile);
				break;
			case "down": {
				const pane = panes.get(e.id);
				if (pane) {
					panes.delete(e.id);
					void closePane(pane);
				}
				if (finished(st)) void shutdown();
				break;
			}
		}
	};

	const humanPending = () => (st.mailbox[HUMAN] ?? []).length;

	// ------------------------------------------------------------ placement

	const childArgs = (id: string, inc: number, spec: SpawnRequest, parentSession?: string, resumeSession?: string): string[] => {
		const args = [
			"-e", join(config.runtimeDir, "index.ts"),
			`--actors-runtime=${config.runtimeDir}`,
			`--actors-socket=${sock}`,
			`--actors-tree=${config.treeId}`,
			`--actors-id=${id}`,
			`--actors-inc=${inc}`,
			"--session-dir", sessionsDir,
		];
		if (resumeSession) args.push("--session", resumeSession);
		else if (spec.context === "fork" && parentSession) args.push("--fork", parentSession);
		// Built-in pi options take the value as a separate argument; only extension flags accept --name=value.
		if (spec.model) args.push("--model", spec.model);
		if (spec.thinking) args.push("--thinking", spec.thinking);
		args.push(...(config.childArgs ?? []));
		return args;
	};

	const start = async (id: string, inc: number, spec: SpawnRequest, parentSession?: string, resumeSession?: string) => {
		const cwd = spec.cwd ?? config.rootCwd;
		const piArgs = childArgs(id, inc, spec, parentSession, resumeSession);
		try {
			if (spec.placement === "pane") {
				if (!(await herdrAvailable(config.rootPaneId))) throw new Error("herdr_unavailable");
				const h = await startPane(config.rootPaneId!, paneAgentName(config.treeId, id), cwd, piArgs);
				panes.set(id, h.paneId);
				const held = pendingHello.get(id);
				if (held) {
					pendingHello.delete(id);
					await helloEvent(held.conn, held.frame);
				}
				return;
			}
			const argv = config.childCommand ? [...config.childCommand, ...piArgs] : [...config.piCommand, "--mode", "rpc", ...piArgs];
			startHeadless(config.runtimeDir, { id, inc, socket: sock, argv, cwd, logDir: logsDir, graceMs: TIMING.childGraceMs });
		} catch (err) {
			// The start deadline turns this into DOWN error:start_timeout; record why for /actors.
			writeFileSync(join(logsDir, `${id}.${inc}.start-error`), String(err));
		}
	};

	// ------------------------------------------------------------ frames

	interface HelloFrame {
		t: "hello";
		proto: number;
		id: string;
		inc: number;
		pid: number;
		sessionId?: string;
		sessionFile?: string;
		recordedPidAlive?: boolean;
	}

	const ownsPid = async (f: HelloFrame): Promise<boolean> => {
		const a = st.agents[f.id];
		if (!a || f.id === ROOT) return true;
		if (a.spec?.placement === "pane") {
			const pane = panes.get(f.id);
			return pane ? (await paneForegroundGroup(pane)) === f.pid || a.pid === f.pid : false;
		}
		return a.pid === undefined || a.pid === f.pid;
	};

	const helloEvent = async (c: Conn, f: HelloFrame) => {
		if (f.proto !== PROTO) {
			send(c, { t: "proto_mismatch", broker: PROTO, client: f.proto });
			c.socket.end();
			return;
		}
		c.role = "agent";
		// A pane child can say hello before `herdr agent start` returns its pane: hold it until then.
		const a0 = st.agents[f.id];
		if (a0?.spec?.placement === "pane" && a0.status === "starting" && !panes.has(f.id)) {
			pendingHello.set(f.id, { conn: c, frame: f });
			return;
		}
		const fx = run({
			type: "hello", now: Date.now(), id: f.id, inc: f.inc, pid: f.pid, sessionId: f.sessionId, sessionFile: f.sessionFile,
			ownsPid: await ownsPid(f), recordedPidAlive: f.id === ROOT ? pidAlive(st.agents[ROOT]?.pid) : undefined,
		}, c);
		if (fx.some((e) => e.type === "hold")) pendingHello.set(f.id, { conn: c, frame: f });
	};

	const onFrame = async (c: Conn, f: Record<string, unknown>) => {
		c.lastSeen = Date.now();
		const now = Date.now();
		switch (f.t) {
			case "hello":
				return helloEvent(c, f as unknown as HelloFrame);
			case "keeper_hello": {
				if (f.proto !== PROTO) return c.socket.end();
				c.role = "keeper";
				c.id = String(f.id);
				c.inc = Number(f.inc);
				keeperConn.set(c.id, c);
				return send(c, { t: "welcome" });
			}
			case "proc_start": {
				if (c.role !== "keeper" || !c.id) return;
				run({ type: "procStart", id: c.id, inc: c.inc!, pid: Number(f.pid) });
				const held = pendingHello.get(c.id);
				if (held) {
					pendingHello.delete(c.id);
					await helloEvent(held.conn, held.frame);
				}
				return;
			}
			case "proc_exit":
				if (c.role !== "keeper" || !c.id) return;
				run({ type: "procExit", now, id: c.id, inc: c.inc!, code: (f.code as number | null) ?? null, signal: (f.signal as string | null) ?? null });
				return send(c, { t: "ack_exit" });
			case "hb":
				return send(c, { t: "hb" });
		}
		// Everything below needs an accepted agent connection.
		if (c.role !== "agent" || !c.id || agentConn.get(c.id) !== c) return;
		const id = c.id;
		switch (f.t) {
			case "op": {
				const seq = Number(f.seq);
				const op = String(f.op);
				if (op === "spawn") run({ type: "spawn", now, from: id, seq, req: f.req as SpawnRequest, resumeProcGone: f.resumeProcGone as boolean | undefined });
				else if (op === "send") run({ type: "send", now, from: id, seq, to: String(f.to ?? ""), kind: f.kind as "mail" | "call" | "reply", body: String(f.body ?? ""), tag: f.tag as string | undefined, ref: f.ref as string | undefined, urgent: !!f.urgent, timeoutS: f.timeoutS as number | undefined });
				else if (op === "answer") run({ type: "answer", now, from: id, seq, ref: String(f.ref), body: String(f.body ?? "") });
				else if (op === "exit") run({ type: "exit", now, from: id, seq, result: String(f.result ?? ""), truncated: !!f.truncated, error: !!f.error });
				else if (op === "kill") run({ type: "kill", now, from: id, seq, target: String(f.target) });
				return;
			}
			case "fetch":
				run({ type: "fetch", id: f.human ? HUMAN : id, fetchId: String(f.fetchId), all: !!f.all, kind: f.kind as never, from: f.from as string | undefined, tag: f.tag as string | undefined, ref: f.ref as string | undefined }, c);
				return;
			case "ack":
				run({ type: "ack", id: f.human ? HUMAN : id, msgId: String(f.msgId) });
				return;
			case "release":
				run({ type: "release", id, msgId: String(f.msgId) });
				return;
			case "bye":
				return; // the close that follows disconnects; the reason is informational
			case "inspect":
				return send(c, { t: "inspect", reqId: f.reqId, state: inspect(id) });
			case "stop_tree":
				if (id !== ROOT) return;
				run({ type: "stop", now });
				return;
		}
	};

	const inspect = (forId: string) => ({
		treeId: st.treeId,
		self: forId,
		agents: Object.values(st.agents).map((a) => ({
			id: a.id, parent: a.parent, status: a.status, inc: a.inc, reason: a.reason, connected: a.connected,
			placement: a.spec?.placement, model: a.spec?.model, mailbox: (st.mailbox[a.id] ?? []).length, spawns: a.spawns, limits: a.limits,
		})),
		human: (st.mailbox[HUMAN] ?? []).map((m) => ({ ref: m.ref, from: m.from, body: m.body })),
		pendingCalls: Object.entries(st.calls).filter(([, c]) => c.caller === forId).map(([ref]) => ref),
		liveChildren: Object.values(st.agents).filter((a) => a.parent === forId && a.status !== "down").length,
	});

	// ------------------------------------------------------------ status file

	let statusTimer: NodeJS.Timeout | undefined;
	const writeStatus = () => {
		if (statusTimer) return;
		statusTimer = setTimeout(() => {
			statusTimer = undefined;
			try {
				writeFileSync(join(dir, "status.json"), JSON.stringify({ updated: new Date().toISOString(), pid: process.pid, ...inspect(ROOT) }, null, 1));
			} catch {
				// best effort
			}
		}, 1000);
		statusTimer.unref();
	};

	// ------------------------------------------------------------ server

	try {
		mkdirSync(join(sock, ".."), { recursive: true, mode: 0o700 });
		rmSync(sock, { force: true }); // we hold the lock, so any socket file here is stale
	} catch {
		// ignore
	}
	const server: Server = createServer((socket) => {
		const c: Conn = { socket, lastSeen: Date.now(), buf: "" };
		conns.add(c);
		socket.setEncoding("utf8");
		socket.on("data", (data: string) => {
			const { frames, rest } = decode(c.buf + data);
			c.buf = rest.length > 256 * 1024 ? "" : rest;
			for (const f of frames) void onFrame(c, f as Record<string, unknown>).catch((err) => console.error("frame error", err));
		});
		socket.on("error", () => {});
		socket.on("close", () => {
			conns.delete(c);
			if (c.role === "keeper" && c.id && keeperConn.get(c.id) === c) keeperConn.delete(c.id);
			if (c.role === "agent" && c.id && agentConn.get(c.id) === c) {
				agentConn.delete(c.id);
				if (!stopping) run({ type: "disconnect", now: Date.now(), id: c.id, conn: c.gen! });
			}
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(sock, () => resolve());
	});

	// Recovery: replayed state, downtime-shifted deadlines, swept orphans; logged (D2).
	const downtime = loaded.lastTime ? Math.max(0, Date.now() - loaded.lastTime) : 0;
	if (loaded.events.length > 0 || loaded.snapshot) run({ type: "recover", now: Date.now(), downtimeMs: downtime });
	if (log.needsCompaction() || loaded.events.length > 1000) log.compact(st, Date.now());

	// ------------------------------------------------------------ timers: ticks, heartbeats, sleep, panes

	let lastWall = Date.now();
	let lastMono = performance.now();
	const timer = setInterval(() => {
		const wall = Date.now();
		const mono = performance.now();
		const slept = wall - lastWall - (mono - lastMono);
		lastWall = wall;
		lastMono = mono;
		if (slept > SLEEP_GAP_MS) {
			run({ type: "slept", ms: Math.round(slept) });
			for (const c of conns) c.lastSeen = wall;
		}
		for (const c of conns) if (wall - c.lastSeen > TIMING.heartbeatTimeoutMs) c.socket.destroy();
		const due = nextDeadline(st);
		if (due !== undefined && wall >= due) run({ type: "tick", now: wall });
		if (log.needsCompaction()) log.compact(st, wall);
	}, 1000);

	const paneTimer = setInterval(async () => {
		if (panes.size === 0) return;
		const alive = await listPanes();
		if (!alive) return;
		for (const [id, pane] of panes) {
			if (alive.has(pane)) continue;
			panes.delete(id);
			const a = st.agents[id];
			if (a && a.status !== "down") run({ type: "procExit", now: Date.now(), id, inc: a.inc, code: null, signal: "pane_closed" });
		}
	}, 5000);

	const shutdown = async () => {
		if (stopping) return;
		stopping = true;
		clearInterval(timer);
		clearInterval(paneTimer);
		try {
			log.compact(st, Date.now());
		} catch {
			// keep the uncompacted log
		}
		writeFileSync(join(dir, "status.json"), JSON.stringify({ updated: new Date().toISOString(), finished: finished(st), ...inspect(ROOT) }, null, 1));
		// Keepers would otherwise hold their exit reports for the full grace period.
		for (const k of keeperConn.values()) send(k, { t: "shutdown" });
		await new Promise((r) => setTimeout(r, 100));
		for (const c of conns) c.socket.destroy();
		await new Promise<void>((r) => server.close(() => r()));
		rmSync(sock, { force: true });
		log.close();
		releaseLock(dir);
		resolveDone();
	};

	return {
		stop: shutdown,
		get state() {
			return st;
		},
		done,
	};
}

function pidAlive(pid: number | undefined): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}
