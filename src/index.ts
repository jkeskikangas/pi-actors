// pi-actors extension: three tools (spawn, send, stop), push delivery, reports on settle.
// Agents talk only to each other: a question for the human goes up the tree to the root, whose
// model decides how to ask. The panel shows the tree and transcripts.
// Identity: children get --actors-* flags (never inherited by subprocesses); the root connects
// lazily on its first spawn and records its tree in its session so it can reattach.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, type OverlayHandle } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Client } from "./client/connection.ts";
import { DEFAULT_KEEP_FINISHED_DAYS, ensureBroker, pruneFinishedTrees } from "./client/launcher.ts";
import { dedupeContext, ENTRY_TYPE, endNotice, formatDelivery, Mailroom } from "./client/mailroom.ts";
import { type AgentItem, agentLine, endedRoots, initialState, items, type Line, type PanelAction, type PanelKey, type PanelState, press, summary, view, withSnapshot } from "./client/panel.ts";
import { captureRunner, readSession, renderDelivery, Transcript } from "./client/transcript.ts";
import type { Snapshot } from "./client/connection.ts";
import { closeOwnPaneOnExit, detectMux, paneAgentName, stateRoot } from "./runtime.ts";
import { type Limits, type Message, TIMING } from "./protocol.ts";

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
	captureRunner();
	for (const name of ["runtime", "socket", "tree", "id", "inc", "pane"]) pi.registerFlag(`actors-${name}`, { type: "string", description: `pi-actors internal (${name})` });

	let client: Client | undefined;
	let mailroom: Mailroom | undefined;
	let self = "root";
	let parent: string | null = null;
	let ctxRef: ExtensionContext | undefined;
	let idle = true;
	let lastAssistantText = "";
	let lastRunInteractive = false;
	let usage = { input: 0, output: 0, cacheWrite: 0, cost: 0 };
	/** Children that owe a report. */
	const awaitingReport = new Set<string>();
	const myChildren = new Set<string>();
	/** Agents this one stopped: their end notice tells it nothing new. */
	const stoppedByMe = new Set<string>();
	let lastSnap: Snapshot | undefined;
	let panelOpen = false;
	let uiTimer: NodeJS.Timeout | undefined;
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
		if (signal?.aborted) return Promise.reject(new Error("aborted"));
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
		pruneOnce();
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
				// A tree run by an older pi-actors speaks another protocol: leave it to its grace period.
				if (attempt >= candidates.length - 1 || !/rejected: (down|protocol)|finished/.test(String(err))) throw err;
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
		const gone = (orphaned: boolean) => {
			if (!current()) return;
			client = undefined;
			// A child that lost its identity (tree finished, superseded, or the broker gone past G)
			// must not run on unlinked (F5). Orphaned, nobody else will close its herdr pane;
			// superseded, another process holds the identity and may be in that very pane.
			if (!isChild()) return;
			if (orphaned) closeOwnPaneOnExit(pi.getFlag("actors-pane"));
			terminate();
		};
		c.on("superseded", () => gone(false));
		c.on("rejected", () => gone(true));
		c.on("lost", () => gone(true));
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
	 * The file is keyed by pid and stamped with a token that lives as long as this process (it
	 * survives runtime replacement), so a later process that reuses the pid ignores it (N8). Not a
	 * clock: uptime stops while the machine sleeps.
	 */
	const processToken: string = ((globalThis as Record<symbol, string>)[Symbol.for("pi-actors.process")] ??= randomBytes(8).toString("hex"));
	function carriedTreeId(): string | undefined {
		try {
			const c = JSON.parse(readFileSync(carryPath(), "utf8")) as { treeId?: string; process?: string };
			return c.process === processToken ? c.treeId : undefined;
		} catch {
			return undefined;
		}
	}
	function carryTreeId(treeId: string) {
		try {
			mkdirSync(dirname(carryPath()), { recursive: true, mode: 0o700 });
			writeFileSync(carryPath(), JSON.stringify({ treeId, process: processToken }), { mode: 0o600 });
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

	/** User settings in ~/.pi/agent/pi-actors.json: {"maxDepth": 2, "maxSpawns": 40, "keepFinishedDays": 7}. */
	function readSettings(): Record<string, unknown> {
		try {
			return JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "pi-actors.json"), "utf8"));
		} catch {
			return {};
		}
	}

	/** Once per process, when a root connects: clear old finished trees off the disk. */
	let pruned = false;
	function pruneOnce() {
		if (pruned) return;
		pruned = true;
		const days = readSettings().keepFinishedDays;
		const keep = typeof days === "number" && days >= 0 ? days : DEFAULT_KEEP_FINISHED_DAYS;
		try {
			pruneFinishedTrees(keep * 24 * 3600 * 1000);
		} catch {
			// best effort
		}
	}

	function readLimits(): Partial<Limits> | undefined {
		try {
			const raw = readSettings() as { maxDepth: number; maxSpawns: number };
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
		const shown: Message[] = [];
		for (const m of batch) {
			if (m.kind === "down" || m.tag === "report") awaitingReport.delete(m.kind === "down" ? safeId(m.body) : m.from);
			if (m.kind === "down" && selfInflicted(m)) room.discard(m, c);
			else shown.push(m);
		}
		updateWaiting();
		if (shown.length === 0) return;
		// Always ask for a turn: pi queues it while a run is active and starts one when idle. Our own idle
		// flag lags pi's at settle time, which lost wake-ups (F9).
		const options = { triggerTurn: true, deliverAs: (urgent || shown.some((m) => m.urgent) ? "steer" : "followUp") as "steer" | "followUp" };
		pi.sendMessage({ customType: ENTRY_TYPE, content: formatDelivery(shown), display: true, details: { actors: room.stamp(shown) } }, options);
	}

	/** The end of an agent this one stopped (directly, or the whole tree): nothing to act on. */
	function selfInflicted(m: Message): boolean {
		const d = endNotice(m);
		const base = d.reason.replace(/:unconfirmed$/, "");
		// Any end settles a stop: a stop that came too late (the child was already finishing) must
		// not hide a later incarnation's end.
		const mine = stoppedByMe.delete(d.id);
		return base === "killed:tree_stopped" || (base === "killed" && mine);
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

	// ------------------------------------------------------------ waiting signal (pi-verified-goal)

	function updateWaiting() {
		const waiting = awaitingReport.size > 0;
		if (waiting === wasWaiting) return;
		wasWaiting = waiting;
		pi.events.emit("actors:waiting", { waiting, children: [...awaitingReport] });
	}

	// ------------------------------------------------------------ panel and widget (TUI)

	async function refreshUi() {
		const ctx = ctxRef;
		if (!ctx || ctx.mode !== "tui") return;
		if (!client?.connected) {
			// No tree (stopped) or no broker: nothing current to show, and nobody to answer (N6).
			lastSnap = undefined;
			ctx.ui.setWidget("pi-actors", undefined, { placement: "belowEditor" });
			return;
		}
		lastSnap = await client.inspect();
		const line = summary(lastSnap);
		ctx.ui.setWidget("pi-actors", line ? [line] : undefined, { placement: "belowEditor" });
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
			if (!lastSnap || items({ snap: lastSnap, showEnded: false }).length === 0) return undefined;
			void openPanel(ctx);
			return { consume: true };
		});
	}

	const KEYS: [string, PanelKey][] = [
		["up", "up"], ["down", "down"], ["pageUp", "pageUp"], ["pageDown", "pageDown"], ["home", "home"], ["end", "end"],
		["enter", "enter"], ["escape", "escape"], ["f", "focus"], ["x", "clear"], ["e", "expand"], ["ctrl+o", "expand"],
	];

	/** The transcript follows the user's pi settings, as the main session does. */
	function transcriptOptions() {
		let s: { outputPad?: number; hideThinkingBlock?: boolean } = {};
		try {
			s = pi.getSettings() as typeof s;
		} catch {
			// defaults
		}
		return { outputPad: typeof s.outputPad === "number" ? s.outputPad : 1, hideThinkingBlock: s.hideThinkingBlock ?? false };
	}

	/**
	 * The panel takes the editor's place, like pi's own selectors; an agent's transcript opens full
	 * screen above everything and esc returns to the list. Clearing and pane focus happen while the
	 * panel stays open; it closes on esc. Keys go through matchesKey: with the kitty keyboard
	 * protocol a plain "f" is an escape sequence.
	 */
	function showPanel(ctx: ExtensionContext, snap: Snapshot): Promise<void> {
		let state: PanelState = initialState(snap);
		let busy = false;
		return ctx.ui.custom<void>((tui, theme, _kb, done) => {
			const opts = transcriptOptions();
			const transcripts = new Map<string, Transcript>();
			const transcriptOf = (it: AgentItem, width: number) => {
				const key = `${it.id}\0${it.sessionFile ?? ""}`;
				let t = transcripts.get(key);
				if (!t) transcripts.set(key, (t = new Transcript(tui, ctx.cwd, opts)));
				t.sync(readSession(it.sessionFile));
				t.setExpanded(state.expanded);
				return t.render(width);
			};
			// Panel lines start in pi's output column; transcript lines carry their own padding.
			const pad = " ".repeat(opts.outputPad);
			const style = (l: Line) => (l.tone === "none" ? l.text : pad + theme.fg(l.tone, l.text));
			const rule = (width: number) => theme.fg("borderMuted", "─".repeat(Math.max(0, width)));
			const rows = () => Math.max(8, tui.terminal.rows);
			let overlay: OverlayHandle | undefined;
			const screen: Component = {
				render(width: number) {
					// head, rule, body, rule, foot: exactly the terminal's height.
					const v = view(state, width - pad.length, rows() - 4, (it) => transcriptOf(it, width));
					state = { ...state, scroll: v.scroll, seen: v.seen };
					return [style(v.head), rule(width), ...v.body.map(style), rule(width), style(v.foot)];
				},
				handleInput: (data: string) => onInput(data),
				invalidate() {
					for (const t of transcripts.values()) t.invalidate();
				},
			};
			const syncScreen = () => {
				if (state.viewing && !overlay) overlay = tui.showOverlay?.(screen, { anchor: "top-left", width: "100%", maxHeight: "100%" });
				else if (!state.viewing && overlay) {
					overlay.hide();
					overlay = undefined;
				}
			};
			const refresh = async () => {
				const next = await client?.inspect();
				if (next) {
					lastSnap = next;
					state = withSnapshot(state, next);
					syncScreen();
					tui.requestRender();
				}
			};
			// Transcripts and statuses move while the panel is open.
			const timer = setInterval(() => void refresh(), 2000);
			timer.unref();
			const close = () => {
				clearInterval(timer);
				overlay?.hide();
				overlay = undefined;
				done();
			};
			// Only a clear holds further keys: the rows it removes must not be acted on meanwhile.
			const perform = async (action: PanelAction) => {
				if (action.type !== "forget") return act(ctx, action);
				busy = true;
				try {
					await act(ctx, action);
					await refresh();
				} finally {
					busy = false;
				}
			};
			const onInput = (data: string) => {
				const key = KEYS.find(([id]) => matchesKey(data, id as Parameters<typeof matchesKey>[1]))?.[1];
				if (!key || (busy && key !== "escape")) return;
				const r = press(state, key);
				state = r.state;
				if (r.action.type === "close") return close();
				syncScreen();
				if (r.action.type !== "none")
					void perform(r.action)
						.catch((err) => ctx.ui.notify(`pi-actors: ${(err as Error).message}`, "warning"))
						.then(() => tui.requestRender());
				tui.requestRender();
			};
			// The list: as tall as its rows, at most half the terminal.
			return {
				render(width: number) {
					const v = view({ ...state, viewing: undefined }, width - pad.length, Math.max(3, Math.floor(rows() / 2) - 4), transcriptOf);
					return [rule(width), style(v.head), ...v.body.map(style), style(v.foot), rule(width)];
				},
				handleInput: onInput,
				invalidate() {},
			};
		});
	}

	async function act(ctx: ExtensionContext, action: PanelAction) {
		if (action.type === "notice") return ctx.ui.notify(action.text, "info");
		if (action.type === "forget") {
			const failed = await forget(ctx, action.ids);
			if (failed.length) ctx.ui.notify(`Not cleared: ${failed.join("; ")}`, "warning");
			return;
		}
		if (action.type !== "focusPane" || !lastSnap) return;
		const where = detectMux();
		const pane = lastSnap.agents.find((a) => a.id === action.id)?.paneId;
		const [cmd, args] =
			where?.mux === "herdr" ? ["herdr", ["agent", "focus", paneAgentName(lastSnap.treeId, action.id)]]
			: where?.mux === "tmux" && pane ? ["tmux", ["select-window", "-t", pane, ";", "select-pane", "-t", pane]]
			: [undefined, []];
		if (!cmd) return ctx.ui.notify(`Cannot focus ${action.id}: no herdr or tmux pane known.`, "warning");
		await new Promise<void>((done) =>
			execFile(cmd, args as string[], (err, _out, stderr) => {
				if (err) ctx.ui.notify(`Focus ${action.id} failed: ${(stderr || err.message).trim()}`, "warning");
				done();
			}),
		);
	}

	/**
	 * Remove ended agents from the tree; returns what could not be removed, with why. Uses the
	 * current connection only: reconnecting here could start a new tree the ids are not in.
	 */
	async function forget(_ctx: ExtensionContext, ids: string[]): Promise<string[]> {
		const c = client;
		if (!c || c.isClosed) return ids.map((id) => `${id}: the agent tree is gone`);
		const failed: string[] = [];
		for (const id of ids) {
			const r = await c.op("forget", { target: id });
			if (!r.ok) failed.push(`${id}: ${failText(r as { ok: false; error: string; detail?: string })}`);
		}
		return failed;
	}

	async function openPanel(ctx: ExtensionContext) {
		if (panelOpen || !client) return;
		panelOpen = true;
		try {
			lastSnap = (await client.inspect()) ?? lastSnap;
			if (!lastSnap) return ctx.ui.notify("pi-actors: broker not reachable.", "warning");
			await showPanel(ctx, lastSnap);
		} finally {
			panelOpen = false;
			void refreshUi();
		}
	}

	pi.registerMessageRenderer<{ actors?: { messages?: Message[] } }>(ENTRY_TYPE, renderDelivery);

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
		clearInterval(uiTimer);
		uiTimer = undefined;
		clearInterval(reclaimTimer);
		reclaimTimer = undefined;
		const c = client;
		client = undefined;
		if (!c) return;
		const switching = event.reason === "new" || event.reason === "resume" || event.reason === "fork";
		if (isChild() && switching) await c.op("exit", { result: "session switched", error: true });
		// /new starts over: the tree stops and the next spawn starts a new one. A root keeps its
		// tree across reloads, /resume and /fork (the next runtime reattaches); on quit the tree runs
		// on for the root's grace period, then stops.
		if (!isChild() && event.reason === "new") c.stopTree();
		if (!isChild() && (event.reason === "quit" || event.reason === "new")) rmSync(carryPath(), { force: true });
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
			stoppedByMe.delete(id); // a resumed child is a new incarnation
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
			"Send a message to another agent (its id) or to your parent (\"parent\"). Never blocks: answers, reports and end notices arrive by themselves. Use reply_to to answer a message you received.",
		promptSnippet: "send: message a child or your parent (answers are pushed to you)",
		promptGuidelines: [
			"Messages from other agents arrive by themselves; answer one with send{to, text, reply_to: <its msg id>} when it needs an answer.",
			"A decision you cannot make from your own context goes to your parent with send{to: \"parent\"}. When a child asks you something, answer from your own context if you can; otherwise ask your own parent (quote the question and name the asking agent) or, with no parent, ask the user yourself. Then send the answer back with reply_to.",
		],
		parameters: Type.Object({
			to: Type.String({ description: "Agent id or \"parent\"." }),
			text: Type.String(),
			reply_to: Type.Optional(Type.String({ description: "The msg id you are answering." })),
			urgent: Type.Optional(Type.Boolean({ description: "Deliver mid-turn instead of after the recipient's current run." })),
		}),
		async execute(_id, p, signal, _onUpdate, ctx) {
			ctxRef = ctx;
			await connect(ctx, signal);
			const to = p.to === "parent" ? parent : p.to;
			if (!to) throw new Error("this agent has no parent; ask the user directly");
			const r = await op(ctx, "send", { to, kind: "mail", body: p.text, ref: p.reply_to, urgent: !!p.urgent }, signal);
			if (!r.ok) throw new Error(failText(r));
			if (myChildren.has(to)) awaitingReport.add(to); // only a direct child owes us a report (F12)
			updateWaiting();
			return text(`Sent (msg ${(r as { msgId: string }).msgId}).`);
		},
	});

	pi.registerTool({
		name: "stop",
		label: "Stop agent",
		description: "Stop a descendant agent (and its own children).",
		promptSnippet: "stop: end a child agent you no longer need",
		parameters: Type.Object({ id: Type.String() }),
		async execute(_id, p, signal, _onUpdate, ctx) {
			ctxRef = ctx;
			const r = await op(ctx, "kill", { target: p.id }, signal);
			if (!r.ok) throw new Error(failText(r));
			awaitingReport.delete(p.id);
			stoppedByMe.add(p.id);
			updateWaiting();
			return text(`Stopping ${p.id}.`);
		},
	});

	// ------------------------------------------------------------ commands

	pi.registerCommand("actors", {
		description: "Open the agents panel; /actors stop [id] stops an agent or the whole tree; /actors clear removes ended agents",
		handler: async (args, ctx) => {
			ctxRef = ctx;
			const [sub, target] = args.trim().split(/\s+/);
			if (!client && !rootTreeId(ctx) && !isChild()) return ctx.ui.notify("No agent tree yet (spawn a child first).", "info");
			const c = await connect(ctx);
			if (sub === "stop") {
				if (target) {
					const r = await c.op("kill", { target });
					if (r.ok) stoppedByMe.add(target);
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
			if (sub === "clear") {
				const ids = endedRoots({ snap });
				if (ids.length === 0) return ctx.ui.notify("No ended agents to clear.", "info");
				const failed = await forget(ctx, ids);
				return ctx.ui.notify(failed.length ? `Not cleared: ${failed.join("; ")}` : `Cleared ${ids.length} ended subtree${ids.length === 1 ? "" : "s"}.`, failed.length ? "warning" : "info");
			}
			if (ctx.mode === "tui") return openPanel(ctx);
			const rows = items({ snap, showEnded: true });
			ctx.ui.notify(rows.length ? rows.map((it) => (it.kind === "ended" ? `${it.count} ended:` : `${"  ".repeat(it.depth)}${agentLine(it)}`)).join("\n") : "No agents.", "info");
		},
	});

}
