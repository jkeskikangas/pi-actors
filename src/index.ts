// pi-actors extension: three tools (spawn, send, stop), push delivery, reports on settle.
// Identity: children get --actors-* flags (never inherited by subprocesses); the root connects
// lazily on its first spawn and records its tree in its session so it can reattach.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Client } from "./client/connection.ts";
import { ensureBroker } from "./client/launcher.ts";
import { dedupeContext, ENTRY_TYPE, formatDelivery, Mailroom } from "./client/mailroom.ts";
import { encodeQuestion, formatAnswer, itemsFrom, openCard, type PanelAction, type PanelKey, type PanelState, parseQuestion, press, readTranscript, render, summary } from "./client/panel.ts";
import type { Snapshot } from "./client/connection.ts";
import { detectMux, paneAgentName, stateRoot } from "./runtime.ts";
import { type Limits, TIMING } from "./protocol.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT_ENTRY = "pi-actors-root";
const REPORT_LIMIT = 16 * 1024;

/** Double-load rule (spike): decide from argv in the factory, before registering anything. */
function isInertCopy(argv: string[] = process.argv): boolean {
	const flag = argv.find((a) => a.startsWith("--actors-runtime="));
	return !!flag && flag.slice("--actors-runtime=".length) !== HERE;
}

export default function piActors(pi: ExtensionAPI) {
	if (isInertCopy()) return;
	for (const name of ["runtime", "socket", "tree", "id", "inc"]) pi.registerFlag(`actors-${name}`, { type: "string", description: `pi-actors internal (${name})` });

	let client: Client | undefined;
	let mailroom: Mailroom | undefined;
	let self = "root";
	let parent: string | null = null;
	let ctxRef: ExtensionContext | undefined;
	let idle = true;
	let lastAssistantText = "";
	let lastRunInteractive = false;
	let usage = { input: 0, output: 0, cacheWrite: 0, cost: 0 };
	/** Children that owe a report, and questions to the human awaiting an answer. */
	const awaitingReport = new Set<string>();
	const awaitingHuman = new Set<string>();
	const myChildren = new Set<string>();
	/** Question ids in the order the last /inbox listing showed them. */
	let lastListing: string[] = [];
	let herdrBlocked = false;
	let herdrLabel = "";
	let lastSnap: Snapshot | undefined;
	let panelOpen = false;
	let uiTimer: NodeJS.Timeout | undefined;
	/** Dialogs open in this pane for our own questions, dismissed when the answer arrives elsewhere. */
	const openDialogs = new Map<string, AbortController>();
	let wasWaiting = false;

	const isChild = () => !!pi.getFlag("actors-id");

	// ------------------------------------------------------------ connection

	let connecting: Promise<Client> | undefined;

	/** Run an op; if the connection closed underneath it (tree finished, superseded), reconnect once. */
	async function op(ctx: ExtensionContext, name: string, fields: Record<string, unknown>, signal?: AbortSignal) {
		const c = await connect(ctx, signal);
		const r = await c.op(name, fields, signal);
		if (!r.ok && r.error === "not_live" && c.isClosed && !signal?.aborted) return (await connect(ctx, signal)).op(name, fields, signal);
		return r;
	}

	/** One connection per agent: concurrent tool calls share the same in-flight connect (F2). */
	function connect(ctx: ExtensionContext, signal?: AbortSignal): Promise<Client> {
		if (client && !client.isClosed) return Promise.resolve(client); // ops queue while it reconnects
		connecting ??= doConnect(ctx).finally(() => (connecting = undefined));
		if (!signal) return connecting;
		// A tool call can stop waiting; the shared connect carries on for the next caller (N3).
		return new Promise<Client>((resolve, reject) => {
			const onAbort = () => reject(new Error("aborted"));
			signal.addEventListener("abort", onAbort, { once: true });
			connecting!.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
		});
	}

	async function doConnect(ctx: ExtensionContext): Promise<Client> {
		const sm = ctx.sessionManager;
		if (isChild()) {
			return open(ctx, {
				socket: String(pi.getFlag("actors-socket")), id: String(pi.getFlag("actors-id")), inc: Number(pi.getFlag("actors-inc")),
				pid: process.pid, sessionId: sm.getSessionId(), sessionFile: sm.getSessionFile(),
			}, TIMING.childGraceMs);
		}
		// The root: the tree this process is running (carried across a session switch) wins over
		// the tree the session recorded (N4); then the recorded one; then a new one. A finished tree
		// (stopped, or its root was gone too long) is skipped (F7).
		const candidates = [...new Set([carriedTreeId(), rootTreeId(ctx)].filter((x): x is string => !!x)), newTreeId()];
		for (let attempt = 0; ; attempt++) {
			const treeId = candidates[attempt];
			const where = detectMux();
			const launch = { treeId, rootCwd: ctx.cwd, mux: where?.mux, rootPaneId: where?.pane, childArgs: jsonEnv("PI_ACTORS_CHILD_ARGS"), childCommand: jsonEnv("PI_ACTORS_CHILD_COMMAND"), limits: readLimits() };
			try {
				const socket = await ensureBroker(launch);
				const c = await open(ctx, { socket, id: "root", inc: 1, pid: process.pid, sessionId: sm.getSessionId(), sessionFile: sm.getSessionFile() }, TIMING.rootGraceMs, () => ensureBroker(launch).then(() => {}));
				if (rootTreeId(ctx) !== treeId) pi.appendEntry(ROOT_ENTRY, { treeId });
				carryTreeId(treeId);
				return c;
			} catch (err) {
				if (attempt >= candidates.length - 1 || !/rejected: down|finished/.test(String(err))) throw err;
			}
		}
	}

	async function open(ctx: ExtensionContext, identity: ConstructorParameters<typeof Client>[0], grace: number, redial?: () => Promise<void>): Promise<Client> {
		const c = new Client(identity, grace, redial);
		c.usage = () => usage;
		const room = new Mailroom(identity.id);
		room.restore(ctx.sessionManager.getEntries());
		const current = () => client === c;
		c.on("welcome", (w: { parent?: string | null; mailbox?: number }) => {
			if (!current()) return;
			parent = w.parent ?? null;
			if ((w.mailbox ?? 0) > 0) void deliver();
		});
		c.on("mail", (urgent: boolean) => {
			if (!current()) return;
			void deliver(urgent);
			void refreshUi();
		});
		c.on("terminate", () => current() && terminate());
		const gone = () => {
			if (!current()) return;
			client = undefined;
			// A child that lost its identity (tree finished, superseded, or the broker gone past G)
			// must not run on unlinked (F5).
			if (isChild()) terminate();
		};
		c.on("superseded", gone);
		c.on("rejected", gone);
		c.on("lost", gone);
		// Set before start(): the welcome handler delivers queued mail immediately.
		client = c;
		mailroom = room;
		self = identity.id;
		try {
			await c.start();
		} catch (err) {
			if (client === c) client = undefined;
			throw err;
		}
		if (ctxRef) {
			startUi(ctxRef);
			startReclaim(ctxRef);
		}
		void refreshUi();
		return c;
	}

	const newTreeId = () => randomBytes(5).toString("hex"); // F16: random, not UUIDv7 timestamp bits
	const carryPath = () => join(stateRoot(), "roots", `${process.pid}.json`);
	/**
	 * A root's session switch (/new, /resume, /fork) replaces the runtime in the same process (F11).
	 * The file is keyed by pid and stamped with this process's start time, so a later process that
	 * reuses the pid after a crash ignores it (N8).
	 */
	const processStart = Math.round(Date.now() / 1000 - process.uptime());
	function carriedTreeId(): string | undefined {
		try {
			const c = JSON.parse(readFileSync(carryPath(), "utf8")) as { treeId?: string; started?: number };
			return c.started !== undefined && Math.abs(c.started - processStart) <= 2 ? c.treeId : undefined;
		} catch {
			return undefined;
		}
	}
	function carryTreeId(treeId: string) {
		try {
			mkdirSync(dirname(carryPath()), { recursive: true, mode: 0o700 });
			writeFileSync(carryPath(), JSON.stringify({ treeId, started: processStart }), { mode: 0o600 });
		} catch {
			// best effort: without it a session switch starts a new tree
		}
	}

	function rootTreeId(ctx: ExtensionContext): string | undefined {
		for (const e of ctx.sessionManager.getEntries().slice().reverse()) {
			const x = e as { type?: string; customType?: string; data?: { treeId?: string } };
			if (x.type === "custom" && x.customType === ROOT_ENTRY && x.data?.treeId) return x.data.treeId;
		}
		return undefined;
	}

	/** User limits from ~/.pi/agent/pi-actors.json: {"maxDepth": 2, "maxSpawns": 40}. */
	function readLimits(): Partial<Limits> | undefined {
		try {
			const raw = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "pi-actors.json"), "utf8"));
			const out: Partial<Limits> = {};
			if (Number.isInteger(raw.maxDepth) && raw.maxDepth >= 0) out.maxDepth = raw.maxDepth;
			if (Number.isInteger(raw.maxSpawns) && raw.maxSpawns >= 0) out.maxSpawns = raw.maxSpawns;
			return out;
		} catch {
			return undefined;
		}
	}

	/** Test hooks: PI_ACTORS_CHILD_ARGS (extra pi args) and PI_ACTORS_CHILD_COMMAND, as JSON arrays. */
	function jsonEnv(name: string): string[] | undefined {
		try {
			return process.env[name] ? JSON.parse(process.env[name]!) : undefined;
		} catch {
			return undefined;
		}
	}

	function terminate() {
		const ctx = ctxRef;
		ctx?.abort();
		if (ctx?.mode === "rpc" || ctx?.mode === "json" || ctx?.mode === "print") process.kill(process.pid, "SIGTERM");
		else ctx?.shutdown();
	}

	// ------------------------------------------------------------ push delivery

	async function deliver(urgent = false) {
		const c = client;
		const room = mailroom;
		if (!c || !room) return;
		const batch = await room.drain(c);
		if (batch.length === 0) return;
		for (const m of batch) {
			if (m.kind === "down" || m.tag === "report") awaitingReport.delete(m.kind === "down" ? safeId(m.body) : m.from);
			// Any reply to our question clears it: the human's answer, or the broker's timeout/root_down (F12).
			if (m.ref && awaitingHuman.has(m.ref)) {
				awaitingHuman.delete(m.ref);
				openDialogs.get(m.ref)?.abort();
				openDialogs.delete(m.ref);
			}
		}
		updateWaiting();
		signalHerdr();
		const content = formatDelivery(self, batch);
		// Always ask for a turn: pi queues it while a run is active and starts one when idle. Our own idle
		// flag lags pi's at settle time, which lost wake-ups (F9).
		const options = { triggerTurn: true, deliverAs: (urgent || batch.some((m) => m.urgent) ? "steer" : "followUp") as "steer" | "followUp" };
		pi.sendMessage({ customType: ENTRY_TYPE, content, display: true, details: { actors: room.stamp(batch) } }, options);
	}

	const safeId = (body: string) => {
		try {
			return String(JSON.parse(body).id);
		} catch {
			return "";
		}
	};

	function ackPersisted(ctx: ExtensionContext) {
		if (client && mailroom) mailroom.settle(ctx.sessionManager.getEntries(), client);
	}

	// ------------------------------------------------------------ waiting signal (pi-verified-goal) and herdr

	function updateWaiting() {
		const waiting = awaitingReport.size > 0 || awaitingHuman.size > 0;
		if (waiting === wasWaiting) return;
		wasWaiting = waiting;
		pi.events.emit("actors:waiting", { waiting, children: [...awaitingReport], human: awaitingHuman.size });
	}

	/**
	 * herdr: block the pane where the human would answer. A pane child blocks its own pane for its
	 * own questions; the root blocks for questions from headless agents (and itself), whose
	 * answers go through its panel. Edge-triggered and paired, so the integration's count is exact.
	 */
	function signalHerdr() {
		const where = detectMux();
		if (!where || ctxRef?.mode !== "tui") return;
		let askers: string[] = [];
		if (self === "root") askers = (lastSnap?.human ?? []).filter((q) => !q.fromPane).map((q) => q.from);
		else if (awaitingHuman.size > 0 && client?.connected) askers = [self];
		const want = askers.length > 0;
		const label = want ? `pi-actors: ${askers.length} question${askers.length === 1 ? "" : "s"} (${[...new Set(askers)].join(", ")})`.slice(0, 120) : "";
		if (want === herdrBlocked && label === herdrLabel) return;
		if (where.mux === "herdr") {
			if (herdrBlocked) pi.events.emit("herdr:blocked", { active: false });
			if (want) pi.events.emit("herdr:blocked", { active: true, label });
		} else if (want && !herdrBlocked) {
			// tmux has no "waiting for you" state: ring the bell (tmux flags the window) and say why.
			process.stdout.write("\x07");
			execFile("tmux", ["display-message", "-t", where.pane, "-d", "8000", label], () => {});
		}
		herdrBlocked = want;
		herdrLabel = label;
	}

	// ------------------------------------------------------------ panel and widget (TUI)

	async function refreshUi() {
		const ctx = ctxRef;
		if (!ctx || ctx.mode !== "tui") return;
		if (!client?.connected) {
			// No tree (stopped) or no broker: nothing current to show, and nobody to answer (N6).
			lastSnap = undefined;
			ctx.ui.setWidget("pi-actors", undefined, { placement: "belowEditor" });
			signalHerdr();
			return;
		}
		lastSnap = await client.inspect();
		const line = summary(lastSnap);
		ctx.ui.setWidget("pi-actors", line ? [line] : undefined, { placement: "belowEditor" });
		signalHerdr();
	}

	/** Every agent, any mode: catch pushes pi dropped while the agent sits idle (F4). */
	let reclaimTimer: NodeJS.Timeout | undefined;
	function startReclaim(ctx: ExtensionContext) {
		if (reclaimTimer) return;
		reclaimTimer = setInterval(() => {
			if (!idle || !client || !mailroom) return;
			const lost = mailroom.reclaim(ctx.sessionManager.getEntries());
			for (const id of lost) client.release(id);
			if (lost.length) void deliver();
		}, 10_000);
		reclaimTimer.unref();
	}

	function startUi(ctx: ExtensionContext) {
		if (ctx.mode !== "tui" || uiTimer) return;
		uiTimer = setInterval(() => void refreshUi(), 5000);
		uiTimer.unref();
		ctx.ui.onTerminalInput((data) => {
			if (panelOpen || !matchesKey(data, "down") || ctx.ui.getEditorText() !== "") return undefined;
			if (!lastSnap || itemsFrom(lastSnap).length === 0) return undefined;
			void openPanel(ctx);
			return { consume: true };
		});
	}

	/** Show the panel overlay from `initial`; resolves with the action that closed it. */
	function showPanel(ctx: ExtensionContext, initial: PanelState, signal?: AbortSignal): Promise<PanelAction> {
		let state = initial;
		return ctx.ui.custom<PanelAction>(
			(tui, theme, _kb, done) => {
				// Answered elsewhere (root panel vs the asker's pane): close this one.
				signal?.addEventListener("abort", () => done({ type: "close" }), { once: true });
				return {
					render(width: number) {
						const rule = theme.fg("borderMuted", "─".repeat(Math.max(0, width)));
						const body = render(state, (it) => readTranscript(it.sessionFile)).map((l, i) =>
							// Padded to the full width so the overlay covers what is underneath.
							truncateToWidth(i === 0 ? theme.fg("accent", l) : l.startsWith("❯") ? theme.fg("text", l) : theme.fg("muted", l), width, "…", true),
						);
						return [rule, ...body, rule];
					},
					handleInput(data: string) {
						const key: PanelKey | undefined = matchesKey(data, "up")
							? "up"
							: matchesKey(data, "down")
								? "down"
								: matchesKey(data, "enter")
									? "enter"
									: matchesKey(data, "escape")
										? "escape"
										: data === " "
											? "space"
											: data === "f"
												? "focus"
												: data === "d"
													? "decline"
													: data === "t"
														? "transcript"
														: undefined;
						if (!key) return;
						const r = press(state, key);
						state = r.state;
						if (r.action.type !== "none") done(r.action);
						else tui.requestRender();
					},
					invalidate() {},
				};
			},
			{ overlay: true, overlayOptions: { width: "100%", maxHeight: "70%", anchor: "center" } },
		);
	}

	/** Carry out what the panel decided: the answer goes to exactly the agent and question selected. */
	async function act(ctx: ExtensionContext, action: PanelAction) {
		const c = client;
		if (!c) return;
		let body: string | undefined;
		if (action.type === "answer") body = action.body;
		else if (action.type === "freeText") {
			const typed = await ctx.ui.input(`Answer ${action.from}: ${action.q.text.slice(0, 200)}`, action.picked.length ? `with ${action.picked.join(", ")}` : "your answer");
			if (typed?.trim()) body = formatAnswer(action.q, action.picked, typed);
		} else if (action.type === "focusPane" && lastSnap) {
			const where = detectMux();
			const pane = lastSnap.agents.find((a) => a.id === action.id)?.paneId;
			if (where?.mux === "herdr") execFile("herdr", ["agent", "focus", paneAgentName(lastSnap.treeId, action.id)], () => {});
			else if (where?.mux === "tmux" && pane) execFile("tmux", ["select-window", "-t", pane, ";", "select-pane", "-t", pane], () => {});
		}
		if (body === undefined || (action.type !== "answer" && action.type !== "freeText")) return;
		const r = await c.op("answer", { ref: action.ref, body });
		ctx.ui.notify(r.ok ? `Answered ${action.from}.` : `Not delivered: ${failText(r as { ok: false; error: string })}`, r.ok ? "info" : "warning");
	}

	async function openPanel(ctx: ExtensionContext) {
		if (panelOpen || !client) return;
		panelOpen = true;
		try {
			lastSnap = (await client.inspect()) ?? lastSnap;
			if (!lastSnap) return ctx.ui.notify("pi-actors: broker not reachable.", "warning");
			await act(ctx, await showPanel(ctx, { items: itemsFrom(lastSnap), selected: 0 }));
		} finally {
			panelOpen = false;
			void refreshUi();
		}
	}

	// ------------------------------------------------------------ lifecycle

	pi.on("session_start", async (event, ctx) => {
		ctxRef = ctx;
		if (event.reason === "reload") mailroom?.forgetInFlight();
		if (isChild() || rootTreeId(ctx) || carriedTreeId()) {
			try {
				await connect(ctx);
			} catch (err) {
				ctx.ui.notify(`pi-actors: ${(err as Error).message}`, "warning");
			}
		}
	});

	pi.on("session_shutdown", async (event) => {
		if (herdrBlocked) pi.events.emit("herdr:blocked", { active: false });
		herdrBlocked = false;
		herdrLabel = "";
		clearInterval(uiTimer);
		uiTimer = undefined;
		clearInterval(reclaimTimer);
		reclaimTimer = undefined;
		const c = client;
		client = undefined;
		if (!c) return;
		const switching = event.reason === "new" || event.reason === "resume" || event.reason === "fork";
		if (isChild() && switching) await c.op("exit", { result: "session switched", error: true });
		// A root keeps its tree across reloads and session switches (the next runtime reattaches);
		// on quit the tree runs on for the root's grace period, then stops.
		if (!isChild() && event.reason === "quit") rmSync(carryPath(), { force: true });
		c.close(event.reason === "quit" && isChild() ? "quit" : "reload");
	});

	pi.on("input", async (event) => {
		lastRunInteractive = (event as { source?: string }).source === "interactive";
	});
	pi.on("agent_start", async () => {
		idle = false;
	});
	pi.on("message_end", async (event) => {
		const m = event.message as { role?: string; content?: unknown; usage?: { input?: number; output?: number; cacheWrite?: number; cost?: { total?: number } } };
		if (m.role !== "assistant") return;
		const text = Array.isArray(m.content) ? m.content.filter((b: { type?: string }) => b?.type === "text").map((b: { text?: string }) => b.text ?? "").join("") : "";
		if (text.trim()) lastAssistantText = text;
		usage = { input: usage.input + (m.usage?.input ?? 0), output: usage.output + (m.usage?.output ?? 0), cacheWrite: usage.cacheWrite + (m.usage?.cacheWrite ?? 0), cost: usage.cost + (m.usage?.cost?.total ?? 0) };
	});
	pi.on("turn_end", async (_e, ctx) => ackPersisted(ctx));
	// Exactly-once as the model sees it, whatever pi did with its queues (N1).
	pi.on("context", async (event) => {
		const messages = dedupeContext(self, event.messages);
		return messages ? { messages } : undefined;
	});
	pi.on("agent_settled", async (_e, ctx) => {
		idle = true;
		ackPersisted(ctx);
		// Pushes pi dropped (its queues are cleared on Esc) never reached the session: release their
		// leases and deliver them again (F4).
		if (client && mailroom) for (const id of mailroom.reclaim(ctx.sessionManager.getEntries())) client.release(id);
		// A child's final answer is its report (no exit tool to forget).
		if (isChild() && client && parent && lastAssistantText.trim() && !lastRunInteractive) {
			const body = lastAssistantText.length > REPORT_LIMIT ? `${lastAssistantText.slice(0, REPORT_LIMIT)}\n…(truncated; full text in ${ctx.sessionManager.getSessionFile()})` : lastAssistantText;
			lastAssistantText = "";
			await client.op("send", { to: parent, kind: "mail", tag: "report", body });
		}
		lastRunInteractive = false;
		void deliver(); // anything that arrived while busy
	});

	/** A pane child's question is answered in its own pane; the dialog closes if answered elsewhere. */
	function askInThisPane(ctx: ExtensionContext, ref: string, body: string) {
		const ac = new AbortController();
		openDialogs.set(ref, ac);
		const item = { kind: "question" as const, ref, from: self, body };
		void showPanel(ctx, { items: [item], selected: 0, card: openCard(item) }, ac.signal)
			.then((action) => act(ctx, action))
			.finally(() => openDialogs.delete(ref));
	}

	// ------------------------------------------------------------ tools

	const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: undefined });
	const isDir = (p: string) => {
		try {
			return statSync(p).isDirectory();
		} catch {
			return false;
		}
	};
	const failText = (r: { ok: false; error: string; detail?: string }) =>
		r.error === "too_large" ? `message too large (${r.detail ?? "over 64 KiB"})` : `${r.error}${r.detail ? `: ${r.detail}` : ""}`;

	pi.registerTool({
		name: "spawn",
		label: "Spawn agent",
		description:
			"Start a child agent on a task. Returns its id immediately; its report (its final answer) is pushed to you each time it finishes a run, so end your turn to wait. Spawn several in a row to run them in parallel. Continue a finished child with send. fork: true gives the child your whole conversation.",
		promptSnippet: "spawn: start a child agent (fresh or forked from this conversation, any model)",
		promptGuidelines: [
			"Delegate independent, well-scoped work with spawn; give each child a clear task and expected output. Don't spawn for trivial steps.",
			"After spawning, end your turn: reports and messages arrive by themselves. Never poll.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "What the child should do and what its final answer should contain." }),
			name: Type.Optional(Type.String({ description: "Short readable name, e.g. 'backend'." })),
			model: Type.Optional(Type.String({ description: "provider/model; default: yours." })),
			thinking: Type.Optional(Type.String({ description: "Thinking level, e.g. low, medium, high." })),
			fork: Type.Optional(Type.Boolean({ description: "Start from a copy of this conversation instead of a fresh context." })),
			cwd: Type.Optional(Type.String({ description: "Working directory, e.g. a git worktree." })),
			pane: Type.Optional(Type.Boolean({ description: "Run in a visible pane the human can watch and talk to (only when pi runs inside herdr or tmux)." })),
			timeout_minutes: Type.Optional(Type.Number({ description: "Stop the child after this much active time." })),
			resume: Type.Optional(Type.String({ description: "Id of an ended child to restart with its conversation." })),
		}),
		async execute(_id, p, signal, _onUpdate, ctx) {
			ctxRef = ctx;
			if (p.fork && !ctx.sessionManager.getSessionFile()) throw new Error("fork needs a saved session; send a message first, then fork.");
			// Relative paths are the agent's, not the broker's (F1).
			const cwd = p.cwd ? resolve(ctx.cwd, p.cwd) : ctx.cwd;
			if (!isDir(cwd)) throw new Error(`cwd ${cwd} is not a directory`);
			// herdr is optional: without it, pane children are unavailable and headless is the default.
			if (p.pane && !detectMux()) throw new Error("pane: true needs pi to run inside herdr or tmux; omit pane to run the child headless.");
			const r = await op(ctx, "spawn", {
				req: { name: p.name, task: p.task, model: p.model, thinking: p.thinking, context: p.fork ? "fork" : "fresh", cwd, placement: p.pane ? "pane" : "headless", timeoutS: p.timeout_minutes ? p.timeout_minutes * 60 : undefined, resume: p.resume },
			}, signal);
			if (!r.ok) throw new Error(r.error === "limit_depth" ? "limit_depth: do this work yourself; this agent may not spawn deeper." : failText(r));
			const id = (r as { id: string }).id;
			myChildren.add(id);
			awaitingReport.add(id);
			updateWaiting();
			return text(`Started ${id}. Its report will arrive by itself; end your turn when you have nothing else to do.`);
		},
	});

	pi.registerTool({
		name: "send",
		label: "Send message",
		description:
			"Send a message to another agent (its id), to your parent (\"parent\"), or to the human (\"human\", for decisions only a human can make). Never blocks: answers arrive by themselves. Use reply_to to answer a message you received.",
		promptSnippet: "send: message a child, your parent or the human (answers are pushed to you)",
		parameters: Type.Object({
			to: Type.String({ description: "Agent id, \"parent\" or \"human\"." }),
			text: Type.String(),
			reply_to: Type.Optional(Type.String({ description: "The msg id you are answering." })),
			choices: Type.Optional(
				Type.Array(Type.Object({ label: Type.String(), description: Type.Optional(Type.String()) }), {
					description: "For a question: the options to pick from (the human can always type something else).",
				}),
			),
			multi: Type.Optional(Type.Boolean({ description: "With choices: allow picking several." })),
			urgent: Type.Optional(Type.Boolean({ description: "Deliver mid-turn instead of after the recipient's current run." })),
		}),
		async execute(_id, p, signal, _onUpdate, ctx) {
			ctxRef = ctx;
			await connect(ctx, signal);
			const to = p.to === "parent" ? parent : p.to;
			if (!to) throw new Error("this agent has no parent");
			const kind = to === "human" ? "call" : "mail";
			const choices = p.choices ?? [];
			// The human gets a structured question (a card); an agent gets the options as text.
			const body = to === "human" ? encodeQuestion(p.text, choices, !!p.multi) : choices.length ? `${p.text}\nOptions${p.multi ? " (pick any)" : ""}: ${choices.map((c) => c.label).join(" / ")}` : p.text;
			const r = await op(ctx, "send", { to, kind, body, ref: p.reply_to, urgent: !!p.urgent, timeoutS: to === "human" ? 24 * 3600 : undefined }, signal);
			if (!r.ok) throw new Error(failText(r));
			const msgId = (r as { msgId: string }).msgId;
			if (to === "human") {
				awaitingHuman.add(msgId);
				signalHerdr();
				if (isChild() && ctx.mode === "tui") askInThisPane(ctx, msgId, body);
			} else if (myChildren.has(to)) awaitingReport.add(to); // only a direct child owes us a report (F12)
			updateWaiting();
			return text(`Sent (msg ${msgId}).${to === "human" ? " The human's answer will arrive by itself." : ""}`);
		},
	});

	pi.registerTool({
		name: "stop",
		label: "Stop agent",
		description: "Stop a descendant agent (and its own children). Its end notice arrives by itself.",
		promptSnippet: "stop: end a child agent you no longer need",
		parameters: Type.Object({ id: Type.String() }),
		async execute(_id, p, signal, _onUpdate, ctx) {
			ctxRef = ctx;
			const r = await op(ctx, "kill", { target: p.id }, signal);
			if (!r.ok) throw new Error(failText(r));
			awaitingReport.delete(p.id);
			updateWaiting();
			return text(`Stopping ${p.id}; its end notice will arrive by itself.`);
		},
	});

	// ------------------------------------------------------------ commands

	pi.registerCommand("actors", {
		description: "Show the agent tree; /actors stop [id] stops an agent or the whole tree",
		handler: async (args, ctx) => {
			ctxRef = ctx;
			const [sub, target] = args.trim().split(/\s+/);
			if (!client && !rootTreeId(ctx) && !isChild()) return ctx.ui.notify("No agent tree yet (spawn a child first).", "info");
			const c = await connect(ctx);
			if (sub === "stop") {
				if (target) {
					const r = await c.op("kill", { target });
					return ctx.ui.notify(r.ok ? `Stopping ${target}.` : failText(r as { ok: false; error: string }), r.ok ? "info" : "warning");
				}
				if (self !== "root") return ctx.ui.notify("Only the root can stop the whole tree.", "warning");
				if (ctx.hasUI && !(await ctx.ui.confirm("Stop the whole agent tree?", "Every agent is stopped."))) return;
				c.stopTree();
				// The tree is over: forget it, so the next spawn starts a new one (F7).
				client = undefined;
				rmSync(carryPath(), { force: true });
				setTimeout(() => c.close("quit"), 500).unref();
				return ctx.ui.notify("Stopping the agent tree.", "info");
			}
			const snap = await c.inspect();
			if (!snap) return ctx.ui.notify("Broker not reachable.", "warning");
			const lines = snap.agents
				.map((a) => `${"  ".repeat(a.id === "root" ? 0 : a.id.split(".").length)}${a.id} · ${a.status}${a.reason ? ` (${a.reason})` : ""}${a.model ? ` · ${a.model}` : ""}${a.placement === "pane" ? " · pane" : ""}${a.mailbox ? ` · ${a.mailbox} queued` : ""}`);
			if (snap.human.length) lines.push(`${snap.human.length} question(s) for the human: /inbox`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("inbox", {
		description: "Open the agents panel (questions for you and the agent tree); same as ↓ on an empty editor",
		handler: async (_args, ctx) => {
			ctxRef = ctx;
			if (!client) return ctx.ui.notify("No agent tree.", "info");
			if (ctx.mode === "tui") return openPanel(ctx);
			const qs = (await client.inspect())?.human ?? [];
			if (qs.length === 0) return ctx.ui.notify("No pending questions.", "info");
			const show = (body: string) => {
				const q = parseQuestion(body);
				return q.choices.length ? `${q.text}\n${q.choices.map((c, i) => `  ${i + 1}. ${c.label}${c.description ? ` — ${c.description}` : ""}`).join("\n")}${q.multi ? "\n  (pick any)" : ""}` : q.text;
			};
			lastListing = qs.map((q) => q.ref ?? "");
			ctx.ui.notify(qs.map((q, i) => `#${i + 1} [${q.ref}] from ${q.from}:\n${show(q.body)}`).join("\n\n") + "\n\nAnswer with /answer <#|id> <text>, or pick options: /answer <#|id> 1,3", "info");
		},
	});

	pi.registerCommand("answer", {
		description: "Answer a question from an agent: /answer <#|id> <text>, or /answer <#|id> 1,3 to pick options",
		handler: async (args, ctx) => {
			ctxRef = ctx;
			if (!client) return ctx.ui.notify("No agent tree.", "info");
			const m = /^\s*#?(\S+)\s+([\s\S]+)$/.exec(args);
			if (!m) return ctx.ui.notify("Usage: /answer <#|id> <text>", "warning");
			const qs = (await client.inspect())?.human ?? [];
			// Address the question itself, never a list position that may have shifted (N5).
			const ref = /^\d+$/.test(m[1]) ? lastListing[Number(m[1]) - 1] : m[1];
			const q = ref ? qs.find((x) => x.ref === ref) : undefined;
			if (!q?.ref) return ctx.ui.notify(/^\d+$/.test(m[1]) && !lastListing.length ? "Run /inbox first, or answer by question id." : `Question ${m[1]} is no longer open (answered elsewhere?). Run /inbox again.`, "warning");
			// "1,3" picks options of a question with choices; anything else is free text.
			const question = parseQuestion(q.body);
			const nums = /^\d+(\s*,\s*\d+)*$/.test(m[2].trim()) ? m[2].split(",").map((x) => Number(x.trim()) - 1) : undefined;
			const picked = nums && question.choices.length && nums.every((n) => question.choices[n]) ? nums.map((n) => question.choices[n].label) : undefined;
			const body = picked ? formatAnswer(question, question.multi ? picked : picked.slice(0, 1)) : formatAnswer(question, [], m[2]);
			const r = await client.op("answer", { ref: q.ref, body });
			ctx.ui.notify(r.ok ? `Answered #${m[1]} (${q.from}).` : failText(r as { ok: false; error: string }), r.ok ? "info" : "warning");
		},
	});
}
