// BrokerServer: the only writer of a tree's state. Socket frames become Tree events; every
// event is logged (fsync) before its effects run (design D1, D2, D4, D13).

import { rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { closePane, herdrAvailable, listPanes, paneAgentName, paneForegroundGroup, startPane } from "../placement/pane.ts";
import { closeTmuxPane, listTmuxPanes, startTmuxPane, tmuxAvailable, tmuxPanePid } from "../placement/tmux.ts";
import { signalGroup, startHeadless } from "../placement/headless.ts";
import { decode, encode, PROTO, TIMING } from "../protocol.ts";
import { acquireLock, type Config, ensureDir, ensurePrivateDir, holdsLock, pidAlive, releaseLock } from "../runtime.ts";
import { apply, type Effect, type Event, finished, initial, nextDeadline, replay, ROOT, type SpawnRequest, type TreeState, UNSYNCED_EVENTS } from "../tree.ts";
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

	let timer: NodeJS.Timeout | undefined;
	let paneTimer: NodeJS.Timeout | undefined;
	let lockLost = false;
	function loseLock() {
		if (lockLost) return;
		lockLost = true;
		console.error("lost the broker lock; stopping");
		stopping = true; // no compaction or status writes: the log is not ours any more
		for (const c of conns) c.socket.destroy();
		// No server.close(): it unlinks the socket path, which is now the new broker's. The
		// process exits (main.ts); stop accepting until then.
		server.removeAllListeners("connection");
		server.on("connection", (s) => s.destroy());
		clearInterval(timer);
		clearInterval(paneTimer);
		resolveDone();
	}

	const run = (ev: Event, ctx?: Conn): Effect[] => {
		// Never write to a log another broker owns, not even before the next timer check (N2).
		// Cheap next to the fsync: one small read.
		if (lockLost || !holdsLock(dir)) {
			loseLock();
			return [];
		}
		const r = apply(st, ev);
		st = r.state;
		log.append(ev, Date.now(), !UNSYNCED_EVENTS.has(ev.type));
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
				send(agentConn.get(e.to), { t: "fetched", fetchId: e.fetchId, message: e.message });
				break;
			case "notify":
				send(agentConn.get(e.id), { t: "mail", urgent: e.urgent });
				break;
			case "terminate":
				send(agentConn.get(e.id), { t: "terminate", reason: e.reason });
				break;
			case "signal": {
				const k = keeperConn.get(e.id);
				const a = st.agents[e.id];
				if (k) send(k, { t: "signal", sig: e.sig });
				else if (a?.pid && a.spec?.placement === "headless") signalGroup(a.pid, e.sig);
				else if (panes.has(e.id) && e.sig === "KILL") void mux.close(panes.get(e.id)!);
				break;
			}
			case "start":
				void start(e.id, e.inc, e.spec, e.parentSessionFile, e.resumeSessionFile);
				break;
			case "down": {
				const pane = panes.get(e.id);
				if (pane) {
					panes.delete(e.id);
					void mux.close(pane);
				}
				if (finished(st)) void shutdown();
				break;
			}
		}
	};

	// ------------------------------------------------------------ the root's multiplexer (optional)

	const mux = {
		available: () => (config.mux === "tmux" ? tmuxAvailable(config.rootPaneId) : config.mux === "herdr" ? herdrAvailable(config.rootPaneId) : Promise.resolve(false)),
		start: async (id: string, cwd: string, piArgs: string[]): Promise<string> => {
			if (config.mux === "tmux") {
				// A tmux pane starts with tmux's environment: pass what the child needs explicitly.
				const env: Record<string, string> = {};
				for (const k of ["PI_ACTORS_HOME", "PI_ACTORS_SOCKET_DIR", "PATH"]) if (process.env[k]) env[k] = process.env[k]!;
				return startTmuxPane(config.rootPaneId!, cwd, [...config.piCommand, ...piArgs], env);
			}
			return (await startPane(config.rootPaneId!, paneAgentName(config.treeId, id), cwd, piArgs)).paneId;
		},
		pid: (pane: string) => (config.mux === "tmux" ? tmuxPanePid(pane) : paneForegroundGroup(pane)),
		list: () => (config.mux === "tmux" ? listTmuxPanes() : listPanes()),
		close: (pane: string) => (config.mux === "tmux" ? closeTmuxPane(pane) : closePane(pane)),
	};

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

	/** A child that cannot start ends now with a reason, instead of after the start timeout (F1). */
	const startFailed = (id: string, inc: number, err: unknown) => {
		writeFileSync(join(logsDir, `${id}.${inc}.start-error`), String(err));
		const a = st.agents[id];
		if (a && a.inc === inc && a.status !== "down") run({ type: "procExit", now: Date.now(), id, inc, code: null, signal: "start_failed" });
	};

	const start = async (id: string, inc: number, spec: SpawnRequest, parentSession?: string, resumeSession?: string) => {
		const cwd = spec.cwd ?? config.rootCwd;
		const piArgs = childArgs(id, inc, spec, parentSession, resumeSession);
		try {
			if (spec.placement === "pane") {
				if (!(await mux.available())) throw new Error("no terminal multiplexer (herdr or tmux) for a pane child");
				const paneId = await mux.start(id, cwd, piArgs);
				panes.set(id, paneId);
				run({ type: "placed", id, inc, paneId }); // logged: survives broker restarts (F5)
				const held = pendingHello.get(id);
				if (held) {
					pendingHello.delete(id);
					await helloEvent(held.conn, held.frame);
				}
				return;
			}
			const argv = config.childCommand ? [...config.childCommand, ...piArgs] : [...config.piCommand, "--mode", "rpc", ...piArgs];
			startHeadless(config.runtimeDir, { id, inc, socket: sock, argv, cwd, logDir: logsDir, graceMs: TIMING.childGraceMs }, (err) => startFailed(id, inc, err));
		} catch (err) {
			startFailed(id, inc, err);
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
		if (a.pid !== undefined && a.pid === f.pid) return true; // the recorded pid (also after a restart)
		if (a.spec?.placement === "pane") {
			const pane = panes.get(f.id);
			return pane ? (await mux.pid(pane)) === f.pid : false;
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
			ownsPid: await ownsPid(f), recordedPidAlive: f.id === ROOT ? !!st.agents[ROOT]?.pid && pidAlive(st.agents[ROOT].pid!) : undefined,
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
		// Everything below needs the agent's current connection. A stale one gets an answer, never silence (F2).
		if (c.role !== "agent" || !c.id || agentConn.get(c.id) !== c) {
			if (f.t === "op") send(c, { t: "resp", seq: f.seq, response: { ok: false, error: "not_live", detail: "not the current connection" } });
			if (f.t === "fetch") send(c, { t: "fetched", fetchId: f.fetchId, message: null });
			return;
		}
		const id = c.id;
		switch (f.t) {
			case "op": {
				const seq = Number(f.seq);
				const op = String(f.op);
				if (op === "spawn") {
					const req = f.req as SpawnRequest;
					// Resume only once the broker itself sees the old process gone (F15).
					const old = req?.resume ? st.agents[req.resume] : undefined;
					const resumeProcGone = old ? await processGone(old) : undefined;
					run({ type: "spawn", now, from: id, seq, req, resumeProcGone });
				}
				else if (op === "send") run({ type: "send", now, from: id, seq, to: String(f.to ?? ""), kind: f.kind as "mail", body: String(f.body ?? ""), tag: f.tag as string | undefined, ref: f.ref as string | undefined, urgent: !!f.urgent });
				else if (op === "exit") run({ type: "exit", now, from: id, seq, result: String(f.result ?? ""), truncated: !!f.truncated, error: !!f.error });
				else if (op === "kill") run({ type: "kill", now, from: id, seq, target: String(f.target) });
				else if (op === "forget") run({ type: "forget", now, from: id, seq, target: String(f.target) });
				return;
			}
			case "fetch":
				run({ type: "fetch", id, fetchId: String(f.fetchId), all: !!f.all, kind: f.kind as never, from: f.from as string | undefined, tag: f.tag as string | undefined, ref: f.ref as string | undefined }, c);
				return;
			case "ack":
				run({ type: "ack", id, msgId: String(f.msgId) });
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

	const processGone = async (a: TreeState["agents"][string]): Promise<boolean> => {
		if (a.procGone) return true;
		if (a.spec?.placement === "pane") return a.paneId ? !(await mux.list())?.has(a.paneId) : true;
		return !a.pid || !pidAlive(a.pid);
	};

	const inspect = (forId: string) => ({
		treeId: st.treeId,
		self: forId,
		agents: Object.values(st.agents).map((a) => ({
			id: a.id, parent: a.parent, status: a.status, inc: a.inc, reason: a.reason, connected: a.connected,
			placement: a.spec?.placement, paneId: a.paneId, model: a.spec?.model, mailbox: (st.mailbox[a.id] ?? []).length, spawns: a.spawns, limits: a.limits, sessionFile: a.sessionFile, task: a.spec?.task?.slice(0, 200),
		})),
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

	ensurePrivateDir(dirname(sock)); // shared /tmp: must be ours and private (F6)
	rmSync(sock, { force: true }); // we hold the lock, so any socket file here is stale
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
	// Panes placed before a restart are known again (F5).
	for (const a of Object.values(st.agents)) if (a.paneId && a.status !== "down") panes.set(a.id, a.paneId);
	if (log.needsCompaction() || loaded.events.length > 1000) log.compact(st, Date.now());

	// ------------------------------------------------------------ timers: ticks, heartbeats, sleep, panes

	let lastWall = Date.now();
	let lastMono = performance.now();
	timer = setInterval(() => {
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
		// Never run alongside another broker on the same log (N2).
		if (lockLost || !holdsLock(dir)) return loseLock();
		const due = nextDeadline(st);
		if (due !== undefined && wall >= due) run({ type: "tick", now: wall });
		if (log.needsCompaction()) log.compact(st, wall);
	}, 1000);

	paneTimer = setInterval(async () => {
		if (panes.size === 0) return;
		const alive = await mux.list();
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

	// A finished tree has nothing to serve: exit instead of lingering forever (F7).
	if (finished(st)) void shutdown();

	return {
		stop: shutdown,
		get state() {
			return st;
		},
		done,
	};
}

