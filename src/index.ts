// pi-actors extension: three tools (spawn, send, stop), push delivery, reports on settle.
// Identity: children get --actors-* flags (never inherited by subprocesses); the root connects
// lazily on its first spawn and records its tree in its session so it can reattach.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Client } from "./client/connection.ts";
import { ensureBroker } from "./client/launcher.ts";
import { ENTRY_TYPE, formatDelivery, Mailroom } from "./client/mailroom.ts";
import { itemsFrom, type PanelAction, type PanelKey, type PanelState, press, readTranscript, render, summary } from "./client/panel.ts";
import type { Snapshot } from "./client/connection.ts";
import { paneAgentName } from "./runtime.ts";
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

	async function connect(ctx: ExtensionContext): Promise<Client> {
		if (client?.connected) return client;
		const sm = ctx.sessionManager;
		let identity: ConstructorParameters<typeof Client>[0];
		let grace: number = TIMING.childGraceMs;
		if (isChild()) {
			identity = {
				socket: String(pi.getFlag("actors-socket")), id: String(pi.getFlag("actors-id")), inc: Number(pi.getFlag("actors-inc")),
				pid: process.pid, sessionId: sm.getSessionId(), sessionFile: sm.getSessionFile(),
			};
		} else {
			const treeId = rootTreeId(ctx) ?? sm.getSessionId().replace(/[^A-Za-z0-9]/g, "").slice(0, 10);
			const socket = await ensureBroker({ treeId, rootCwd: ctx.cwd, rootPaneId: process.env.HERDR_PANE_ID, childArgs: childArgsFromEnv(), limits: readLimits() });
			if (!rootTreeId(ctx)) pi.appendEntry(ROOT_ENTRY, { treeId });
			identity = { socket, id: "root", inc: 1, pid: process.pid, sessionId: sm.getSessionId(), sessionFile: sm.getSessionFile() };
			grace = TIMING.rootGraceMs;
		}
		const c = new Client(identity, grace);
		c.usage = () => usage;
		mailroom = new Mailroom(identity.id);
		mailroom.restore(sm.getEntries());
		c.on("welcome", (w: { parent?: string | null; mailbox?: number }) => {
			parent = w.parent ?? null;
			if ((w.mailbox ?? 0) > 0) void deliver();
		});
		c.on("mail", (urgent: boolean, human: number) => {
			void human;
			void deliver(urgent);
			void refreshUi();
		});
		c.on("terminate", () => terminate());
		c.on("superseded", () => (client = undefined));
		c.on("rejected", () => (client = undefined));
		c.on("lost", () => {
			if (isChild()) terminate();
		});
		// Set before start(): the welcome handler delivers queued mail immediately.
		client = c;
		self = identity.id;
		try {
			await c.start();
		} catch (err) {
			client = undefined;
			throw err;
		}
		if (ctxRef) startUi(ctxRef);
		void refreshUi();
		return c;
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

	/** Test hook: extra pi args for children (e.g. a scripted provider), as a JSON array. */
	function childArgsFromEnv(): string[] | undefined {
		try {
			return process.env.PI_ACTORS_CHILD_ARGS ? JSON.parse(process.env.PI_ACTORS_CHILD_ARGS) : undefined;
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
			if (m.from === "human" && m.ref) {
				awaitingHuman.delete(m.ref);
				openDialogs.get(m.ref)?.abort();
				openDialogs.delete(m.ref);
			}
		}
		updateWaiting();
		signalHerdr();
		const content = formatDelivery(self, batch);
		const options = idle ? { triggerTurn: true } : { deliverAs: (urgent || batch.some((m) => m.urgent) ? "steer" : "followUp") as "steer" | "followUp" };
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
		if (process.env.HERDR_ENV !== "1" || ctxRef?.mode !== "tui") return;
		let askers: string[] = [];
		if (self === "root") askers = (lastSnap?.human ?? []).filter((q) => !q.fromPane).map((q) => q.from);
		else if (awaitingHuman.size > 0) askers = [self];
		const want = askers.length > 0;
		const label = want ? `pi-actors: ${askers.length} question${askers.length === 1 ? "" : "s"} (${[...new Set(askers)].join(", ")})`.slice(0, 120) : "";
		if (want === herdrBlocked && label === herdrLabel) return;
		if (herdrBlocked) pi.events.emit("herdr:blocked", { active: false });
		if (want) pi.events.emit("herdr:blocked", { active: true, label });
		herdrBlocked = want;
		herdrLabel = label;
	}

	// ------------------------------------------------------------ panel and widget (TUI)

	async function refreshUi() {
		const ctx = ctxRef;
		if (!ctx || ctx.mode !== "tui" || !client?.connected) return;
		lastSnap = await client.inspect();
		const line = summary(lastSnap);
		ctx.ui.setWidget("pi-actors", line ? [line] : undefined, { placement: "belowEditor" });
		signalHerdr();
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

	async function openPanel(ctx: ExtensionContext) {
		if (panelOpen || !client) return;
		panelOpen = true;
		try {
			lastSnap = (await client.inspect()) ?? lastSnap;
			if (!lastSnap) return ctx.ui.notify("pi-actors: broker not reachable.", "warning");
			let state: PanelState = { items: itemsFrom(lastSnap), selected: 0 };
			const action = await ctx.ui.custom<PanelAction>(
				(tui, theme, _kb, done) => ({
					render(width: number) {
						const rule = theme.fg("borderMuted", "─".repeat(Math.max(0, width)));
						const body = render(state, (it) => readTranscript(it.sessionFile)).map((l, i) =>
							// Padded to the full width so the overlay covers what is underneath.
							truncateToWidth(i === 0 ? theme.fg("accent", l) : l.startsWith("❯") ? theme.fg("text", l) : theme.fg("muted", l), width, "…", true),
						);
						return [rule, ...body, rule];
					},
					handleInput(data: string) {
						const key: PanelKey | undefined = matchesKey(data, "up") ? "up" : matchesKey(data, "down") ? "down" : matchesKey(data, "enter") ? "enter" : matchesKey(data, "escape") ? "escape" : data === "f" ? "focus" : undefined;
						if (!key) return;
						const r = press(state, key);
						state = r.state;
						if (r.action.type !== "none") done(r.action);
						else tui.requestRender();
					},
					invalidate() {},
				}),
				{ overlay: true, overlayOptions: { width: "100%", maxHeight: "70%", anchor: "center" } },
			);
			if (action.type === "answer") {
				const answer = await ctx.ui.input(`Answer ${action.from}: ${action.body.slice(0, 300)}`, "your answer");
				if (answer?.trim()) {
					const r = await client.op("answer", { ref: action.ref, body: answer.trim() });
					ctx.ui.notify(r.ok ? `Answered ${action.from}.` : `Not delivered: ${failText(r as { ok: false; error: string })}`, r.ok ? "info" : "warning");
				}
			} else if (action.type === "focusPane" && lastSnap) {
				execFile("herdr", ["agent", "focus", paneAgentName(lastSnap.treeId, action.id)], () => {});
			}
		} finally {
			panelOpen = false;
			void refreshUi();
		}
	}

	// ------------------------------------------------------------ lifecycle

	pi.on("session_start", async (event, ctx) => {
		ctxRef = ctx;
		if (event.reason === "reload") mailroom?.forgetInFlight();
		if (isChild() || rootTreeId(ctx)) {
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
		const c = client;
		if (!c) return;
		if (isChild() && (event.reason === "new" || event.reason === "resume" || event.reason === "fork")) {
			await c.op("exit", { result: "session switched", error: true });
		}
		c.close(event.reason === "reload" ? "reload" : "quit");
		client = undefined;
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
	pi.on("agent_settled", async (_e, ctx) => {
		idle = true;
		ackPersisted(ctx);
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
	function askInThisPane(ctx: ExtensionContext, ref: string, question: string) {
		const ac = new AbortController();
		openDialogs.set(ref, ac);
		void ctx.ui.input(`Question from ${self}: ${question.slice(0, 300)}`, "your answer", { signal: ac.signal }).then(async (answer) => {
			openDialogs.delete(ref);
			if (!answer?.trim() || !client) return;
			const r = await client.op("answer", { ref, body: answer.trim() });
			if (!r.ok) ctx.ui.notify(`pi-actors: ${failText(r as { ok: false; error: string })}`, "warning");
		});
	}

	// ------------------------------------------------------------ tools

	const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: undefined });
	const failText = (r: { ok: false; error: string; detail?: string }) => `${r.error}${r.detail ? `: ${r.detail}` : ""}`;

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
			pane: Type.Optional(Type.Boolean({ description: "Run in a visible herdr pane the human can watch and talk to (only when pi runs inside herdr)." })),
			timeout_minutes: Type.Optional(Type.Number({ description: "Stop the child after this much active time." })),
			resume: Type.Optional(Type.String({ description: "Id of an ended child to restart with its conversation." })),
		}),
		async execute(_id, p, _signal, _onUpdate, ctx) {
			ctxRef = ctx;
			const c = await connect(ctx);
			if (p.fork && !ctx.sessionManager.getSessionFile()) throw new Error("fork needs a saved session; send a message first, then fork.");
			// herdr is optional: without it, pane children are unavailable and headless is the default.
			if (p.pane && process.env.HERDR_ENV !== "1") throw new Error("pane: true needs pi to run inside herdr; omit pane to run the child headless.");
			const r = await c.op("spawn", {
				req: { name: p.name, task: p.task, model: p.model, thinking: p.thinking, context: p.fork ? "fork" : "fresh", cwd: p.cwd, placement: p.pane ? "pane" : "headless", timeoutS: p.timeout_minutes ? p.timeout_minutes * 60 : undefined, resume: p.resume },
				resumeProcGone: !!p.resume,
			});
			if (!r.ok) throw new Error(r.error === "limit_depth" ? "limit_depth: do this work yourself; this agent may not spawn deeper." : failText(r));
			const id = (r as { id: string }).id;
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
			urgent: Type.Optional(Type.Boolean({ description: "Deliver mid-turn instead of after the recipient's current run." })),
		}),
		async execute(_id, p, _signal, _onUpdate, ctx) {
			ctxRef = ctx;
			const c = await connect(ctx);
			const to = p.to === "parent" ? parent : p.to;
			if (!to) throw new Error("this agent has no parent");
			const kind = to === "human" ? "call" : "mail";
			const r = await c.op("send", { to, kind, body: p.text, ref: p.reply_to, urgent: !!p.urgent, timeoutS: to === "human" ? 24 * 3600 : undefined });
			if (!r.ok) throw new Error(failText(r));
			const msgId = (r as { msgId: string }).msgId;
			if (to === "human") {
				awaitingHuman.add(msgId);
				signalHerdr();
				if (isChild() && ctx.mode === "tui") askInThisPane(ctx, msgId, p.text);
			} else if (to !== parent) awaitingReport.add(to); // the child owes us a new report
			updateWaiting();
			return text(`Sent (msg ${msgId}).${to === "human" ? " The human's answer will arrive by itself." : ""}`);
		},
	});

	pi.registerTool({
		name: "stop",
		label: "Stop agent",
		description: "Stop a descendant agent (and its own children). Returns once it has ended.",
		promptSnippet: "stop: end a child agent you no longer need",
		parameters: Type.Object({ id: Type.String() }),
		async execute(_id, p, _signal, _onUpdate, ctx) {
			ctxRef = ctx;
			const c = await connect(ctx);
			const r = await c.op("kill", { target: p.id });
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
				return ctx.ui.notify("Stopping the agent tree.", "info");
			}
			const snap = await c.inspect();
			if (!snap) return ctx.ui.notify("Broker not reachable.", "warning");
			const lines = snap.agents
				.filter((a) => a.id !== "root" || true)
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
			ctx.ui.notify(qs.map((q, i) => `#${i + 1} from ${q.from}:\n${q.body}`).join("\n\n") + "\n\nAnswer with /answer <#> <text>", "info");
		},
	});

	pi.registerCommand("answer", {
		description: "Answer a question from an agent: /answer <#> <text>",
		handler: async (args, ctx) => {
			ctxRef = ctx;
			if (!client) return ctx.ui.notify("No agent tree.", "info");
			const m = /^\s*#?(\d+)\s+([\s\S]+)$/.exec(args);
			if (!m) return ctx.ui.notify("Usage: /answer <#> <text>", "warning");
			const qs = (await client.inspect())?.human ?? [];
			const q = qs[Number(m[1]) - 1];
			if (!q?.ref) return ctx.ui.notify(`No question #${m[1]}.`, "warning");
			const r = await client.op("answer", { ref: q.ref, body: m[2].trim() });
			ctx.ui.notify(r.ok ? `Answered #${m[1]} (${q.from}).` : failText(r as { ok: false; error: string }), r.ok ? "info" : "warning");
		},
	});
}
