// The agents panel: the agent tree and each agent's transcript, opened with ↓ on an empty editor.
// The state machine is pure (unit-tested); index.ts wraps it in a pi-tui component.

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Message } from "../protocol.ts";
import type { Snapshot } from "./connection.ts";
import { summarizeDelivery } from "./mailroom.ts";

type SnapAgent = Snapshot["agents"][number];

export type AgentItem = {
	kind: "agent";
	id: string;
	status: string;
	reason?: string;
	model?: string;
	placement?: string;
	mailbox: number;
	sessionFile?: string;
	depth: number;
	ended: boolean;
	/** In the ended section: a whole ended subtree whose parent is this agent or has ended too. */
	clearable: boolean;
};

export type PanelItem = AgentItem | { kind: "ended"; count: number; expanded: boolean };

export type PanelKey = "up" | "down" | "pageUp" | "pageDown" | "home" | "end" | "enter" | "escape" | "focus" | "clear" | "expand";

export type PanelAction =
	| { type: "none" }
	| { type: "close" }
	| { type: "focusPane"; id: string }
	/** Ended subtrees to remove from the tree; the panel stays open. */
	| { type: "forget"; ids: string[] }
	| { type: "notice"; text: string };

export interface PanelState {
	snap: Snapshot;
	selected: number;
	showEnded: boolean;
	/** Agent whose transcript is shown, if any. */
	viewing?: string;
	/** Transcript lines scrolled up from the end; 0 follows new output. */
	scroll: number;
	/** Show tool output and whole deliveries in the transcript. */
	expanded: boolean;
	/** Transcript length at the last render: a scrolled-up view stays put while output grows. */
	seen?: number;
}

const ACTIVE = new Set(["starting", "live", "disconnected", "exiting", "killing"]);
export const isActive = (status: string) => ACTIVE.has(status);

export function initialState(snap: Snapshot): PanelState {
	return { snap, selected: 0, showEnded: false, scroll: 0, expanded: false };
}

/** A new snapshot keeps the cursor on the same row where it can. */
export function withSnapshot(st: PanelState, snap: Snapshot): PanelState {
	const before = items(st)[st.selected];
	const next = { ...st, snap };
	const rows = items(next);
	const at = before ? rows.findIndex((x) => sameRow(x, before)) : -1;
	const viewing = st.viewing && snap.agents.some((a) => a.id === st.viewing) ? st.viewing : undefined;
	return { ...next, viewing, scroll: viewing ? st.scroll : 0, selected: at >= 0 ? at : Math.min(st.selected, Math.max(0, rows.length - 1)) };
}

const sameRow = (a: PanelItem, b: PanelItem) => (a.kind === "ended" ? b.kind === "ended" : b.kind === "agent" && b.id === a.id);

/**
 * This agent's subtree. Running agents first, in tree order; an ended agent stays there while a
 * descendant runs, or while its parent (another agent) runs and may still resume it. Then one
 * "ended" row that expands to the ended subtrees, every one of which can be cleared.
 */
export function items(st: Pick<PanelState, "snap" | "showEnded">): PanelItem[] {
	const { running, ended } = sections(st.snap);
	if (ended.length === 0) return running;
	return [...running, { kind: "ended", count: ended.length, expanded: st.showEnded }, ...(st.showEnded ? ended : [])];
}

/** Ended rows are indented within their own ended subtree. */
function sections(snap: Snapshot): { running: AgentItem[]; ended: AgentItem[] } {
	const byParent = new Map<string | null, SnapAgent[]>();
	for (const a of snap.agents) byParent.set(a.parent, [...(byParent.get(a.parent) ?? []), a]);
	const live = new Map<string, boolean>();
	const runs = (a: SnapAgent): boolean => {
		if (!live.has(a.id)) live.set(a.id, isActive(a.status) || (byParent.get(a.id) ?? []).some(runs));
		return live.get(a.id)!;
	};
	const status = new Map(snap.agents.map((a) => [a.id, a.status]));
	const parentRuns = (a: SnapAgent) => a.parent !== snap.self && isActive(status.get(a.parent ?? "") ?? "down");
	const running: AgentItem[] = [];
	const ended: AgentItem[] = [];
	const walk = (parent: string, depth: number, endedDepth: number, inEnded: boolean) => {
		for (const a of byParent.get(parent) ?? []) {
			if (!inEnded && (runs(a) || parentRuns(a))) {
				running.push(item(a, depth, false));
				walk(a.id, depth + 1, 0, false);
			} else {
				ended.push(item(a, endedDepth, true));
				walk(a.id, depth + 1, endedDepth + 1, true);
			}
		}
	};
	walk(snap.self, 0, 0, false);
	return { running, ended };
}

const item = (a: SnapAgent, depth: number, clearable: boolean): AgentItem => ({
	kind: "agent", id: a.id, status: a.status, reason: a.reason, model: a.model, placement: a.placement, mailbox: a.mailbox, sessionFile: a.sessionFile, depth, ended: !isActive(a.status), clearable,
});

/** The tops of the ended subtrees: forgetting these clears every ended row. */
export function endedRoots(st: Pick<PanelState, "snap">): string[] {
	return sections(st.snap).ended.filter((x) => x.depth === 0).map((x) => x.id);
}

export function summary(snap: Snapshot | undefined): string | undefined {
	if (!snap) return undefined;
	const running = snap.agents.filter((a) => a.id !== "root" && isActive(a.status)).length;
	if (running === 0) return undefined;
	return `pi-actors · ${running} running — ↓ to open`;
}

// ---------------------------------------------------------------- labels

const LABELS: Record<string, string> = {
	starting: "starting", live: "running", disconnected: "reconnecting", exiting: "finishing", killing: "stopping",
	normal: "finished", error: "failed", killed: "stopped", "killed:parent_down": "stopped with its parent", "killed:tree_stopped": "stopped with the tree",
	timeout: "timed out", lost: "lost", stopped: "stopped", "error:start_failed": "failed to start", "error:start_timeout": "start timed out",
};

export function statusLabel(status: string, reason?: string): string {
	if (status !== "down") return LABELS[status] ?? status;
	const r = reason ?? "";
	if (r.endsWith(":unconfirmed")) return `${statusLabel("down", r.slice(0, -":unconfirmed".length))}, exit unconfirmed`;
	const crashed = /^error:crashed\((.*)\)$/.exec(r);
	if (crashed) return `crashed (${crashed[1]})`;
	return LABELS[r] ?? (r || "ended");
}

/** "claude-sdk/claude-opus-5-5" -> "opus-5-5". */
export const shortModel = (m?: string) => (m ? m.slice(m.lastIndexOf("/") + 1).replace(/^claude-/, "") : undefined);

export function agentLine(it: AgentItem): string {
	const parts = [statusLabel(it.status, it.reason)];
	const model = shortModel(it.model);
	if (model) parts.push(model);
	if (it.placement === "pane" && !it.ended) parts.push("pane");
	if (it.mailbox && !it.ended) parts.push(`${it.mailbox} queued`);
	return `${it.ended ? "○" : "●"} ${it.id}  ${parts.join(" · ")}`;
}

// ---------------------------------------------------------------- keys

const focusable = (it: PanelItem | undefined): boolean => it?.kind === "agent" && !it.ended && it.placement === "pane";

function focus(it: PanelItem | undefined): PanelAction {
	if (it?.kind !== "agent") return { type: "none" };
	if (focusable(it)) return { type: "focusPane", id: it.id };
	if (it.placement === "pane") return { type: "notice", text: `${it.id} has ended; its pane is closed.` };
	return { type: "notice", text: `${it.id} runs headless; there is no pane to focus.` };
}

function clear(st: PanelState, it: PanelItem | undefined): PanelAction {
	if (it?.kind === "ended") return { type: "forget", ids: endedRoots(st) };
	if (it?.kind === "agent" && it.clearable) return { type: "forget", ids: [it.id] };
	return { type: "none" };
}

const PAGE = 10;

export function press(st: PanelState, key: PanelKey): { state: PanelState; action: PanelAction } {
	const none = (state: PanelState = st) => ({ state, action: { type: "none" } as PanelAction });
	if (st.viewing) {
		const it = viewed(st);
		switch (key) {
			case "escape":
			case "enter":
				return none({ ...st, viewing: undefined, scroll: 0, seen: undefined });
			case "up":
				return none({ ...st, scroll: st.scroll + 1 });
			case "down":
				return none({ ...st, scroll: Math.max(0, st.scroll - 1) });
			case "pageUp":
				return none({ ...st, scroll: st.scroll + PAGE });
			case "pageDown":
				return none({ ...st, scroll: Math.max(0, st.scroll - PAGE) });
			case "home":
				return none({ ...st, scroll: Number.MAX_SAFE_INTEGER });
			case "end":
				return none({ ...st, scroll: 0 });
			case "expand":
				return none({ ...st, expanded: !st.expanded });
			case "focus":
				return { state: st, action: focus(it) };
			case "clear": {
				const action = clear(st, it);
				return action.type === "forget" ? { state: { ...st, viewing: undefined, scroll: 0 }, action } : { state: st, action };
			}
		}
	}
	const rows = items(st);
	const n = rows.length;
	const it = rows[st.selected];
	switch (key) {
		case "up":
			return none({ ...st, selected: n ? (st.selected - 1 + n) % n : 0 });
		case "down":
			return none({ ...st, selected: n ? (st.selected + 1) % n : 0 });
		case "home":
			return none({ ...st, selected: 0 });
		case "end":
			return none({ ...st, selected: Math.max(0, n - 1) });
		case "escape":
			return { state: st, action: { type: "close" } };
		case "focus":
			return { state: st, action: focus(it) };
		case "clear":
			return { state: st, action: clear(st, it) };
		case "enter":
			if (!it) return { state: st, action: { type: "close" } };
			if (it.kind === "ended") return none({ ...st, showEnded: !st.showEnded });
			return none({ ...st, viewing: it.id, scroll: 0, seen: undefined });
		default:
			return none();
	}
}

const viewed = (st: PanelState) => items({ snap: st.snap, showEnded: true }).find((x): x is AgentItem => x.kind === "agent" && x.id === st.viewing);

// ---------------------------------------------------------------- rendering

export type Tone = "accent" | "text" | "muted" | "dim";
export interface Line {
	text: string;
	tone: Tone;
}

/**
 * The panel as toned lines that fit `width` x `height` (styling is index.ts's). Also returns the
 * scroll offset clamped to the transcript, so the caller keeps a reachable value.
 */
export function view(st: PanelState, width: number, height: number, transcript: (it: AgentItem) => Entry[]): { lines: Line[]; scroll: number; seen?: number } {
	const fit = (text: string, tone: Tone): Line => ({ text: truncateToWidth(text, width, "…"), tone });
	const room = Math.max(1, height - 1);
	if (st.viewing) {
		const it = viewed(st);
		const keys = ["↑↓ PgUp/PgDn scroll", `e ${st.expanded ? "collapse" : "expand"}`, ...(focusable(it) ? ["f focus pane"] : []), ...(it?.clearable ? ["x clear"] : []), "esc back"];
		const head = fit(`${it ? agentLine(it) : `${st.viewing} (gone)`}   ${keys.join(" · ")}`, "accent");
		const body = it ? transcriptLines(transcript(it), width, st.expanded) : [];
		const grown = st.scroll > 0 && st.seen !== undefined ? Math.max(0, body.length - st.seen) : 0;
		const scroll = Math.min(st.scroll + grown, Math.max(0, body.length - room));
		const end = body.length - scroll;
		const shown = body.slice(Math.max(0, end - room), end);
		if (scroll > 0) shown[shown.length - 1] = { text: `… ${scroll} more line${scroll === 1 ? "" : "s"} below (End to follow)`, tone: "dim" };
		return { lines: [head, ...(shown.length ? shown : [{ text: "(nothing yet)", tone: "dim" as Tone }])], scroll, seen: body.length };
	}
	const rows = items(st);
	if (rows.length === 0) return { lines: [fit("pi-actors: no agents  (esc close)", "accent")], scroll: 0 };
	const sel = rows[st.selected];
	const keys = ["↑↓ move", sel?.kind === "ended" ? `enter ${st.showEnded ? "collapse" : "expand"}` : "enter transcript"];
	if (focusable(sel)) keys.push("f focus pane");
	if (sel?.kind === "ended") keys.push("x clear all ended");
	else if (sel?.kind === "agent" && sel.clearable) keys.push("x clear");
	keys.push("esc close");
	const lines: Line[] = rows.map((it, i) => {
		const cursor = i === st.selected ? "❯ " : "  ";
		if (it.kind === "ended") return fit(`${cursor}${it.expanded ? "▾" : "▸"} ${it.count} ended`, i === st.selected ? "text" : "dim");
		return fit(`${cursor}${"  ".repeat(it.depth)}${agentLine(it)}`, i === st.selected ? "text" : it.ended ? "dim" : "muted");
	});
	// Keep the cursor visible in a short pane.
	const start = Math.min(Math.max(0, st.selected - room + 1), Math.max(0, lines.length - room));
	return { lines: [fit(`pi-actors  (${keys.join(" · ")})`, "accent"), ...lines.slice(start, start + room)], scroll: 0 };
}

// ---------------------------------------------------------------- transcripts

export type Entry =
	| { kind: "user"; text: string }
	| { kind: "assistant"; text: string }
	| { kind: "delivery"; summary: string; text: string }
	| { kind: "tool"; name: string; arg: string }
	| { kind: "result"; name: string; text: string; error: boolean };

/** Agent-supplied text is shown in the terminal: strip control characters except newline and tab. */
export function clean(s: string): string {
	return s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

function wrap(text: string, width: number, prefix: string, tone: Tone): Line[] {
	const out: Line[] = [];
	const inner = Math.max(10, width - prefix.length);
	for (const para of clean(text).replace(/\t/g, "  ").split("\n")) {
		for (const l of para ? wrapTextWithAnsi(para, inner) : [""]) out.push({ text: `${out.length ? " ".repeat(prefix.length) : prefix}${l}`, tone });
	}
	return out;
}

const RESULT_LINES = 12;

/** Collapsed: what was asked, said and done; expanded adds tool output and whole deliveries. */
export function transcriptLines(entries: readonly Entry[], width: number, expanded: boolean): Line[] {
	const out: Line[] = [];
	const gap = () => out.length && out.push({ text: "", tone: "dim" });
	for (const e of entries) {
		switch (e.kind) {
			case "user":
				gap();
				out.push(...wrap(e.text, width, "› ", "text"));
				break;
			case "assistant":
				gap();
				out.push(...wrap(e.text, width, "", "text"));
				break;
			case "delivery":
				gap();
				out.push(...wrap(expanded ? e.text : e.summary, width, "⇢ ", "muted"));
				break;
			case "tool":
				out.push({ text: truncateToWidth(`  ⚙ ${e.name}${e.arg ? `  ${clean(e.arg).replace(/\s+/g, " ")}` : ""}`, width, "…"), tone: "muted" });
				break;
			case "result": {
				const lines = clean(e.text).replace(/\n+$/, "").split("\n");
				const count = `${lines.length} line${lines.length === 1 ? "" : "s"}`;
				if (!expanded) {
					const one = lines.length === 1 ? lines[0] : count;
					out.push({ text: truncateToWidth(`    ↳ ${e.error ? "error: " : ""}${one || "(empty)"}`, width, "…"), tone: "dim" });
					break;
				}
				out.push({ text: `    ↳ ${e.error ? "error · " : ""}${count}`, tone: "dim" });
				for (const l of lines.slice(0, RESULT_LINES)) out.push({ text: truncateToWidth(`      ${l.replace(/\t/g, "  ")}`, width, "…"), tone: "dim" });
				if (lines.length > RESULT_LINES) out.push({ text: `      … ${lines.length - RESULT_LINES} more`, tone: "dim" });
				break;
			}
		}
	}
	return out;
}

/** The argument that says what a tool call did: a command, a path, a recipient. */
export function keyArg(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const a = args as Record<string, unknown>;
	for (const k of ["command", "path", "file_path", "pattern", "url", "query", "to", "name", "id", "task"]) if (typeof a[k] === "string" && a[k]) return a[k] as string;
	const first = Object.values(a).find((v): v is string => typeof v === "string");
	return first ?? "";
}

function text(c: unknown): string {
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return "";
	return c.map((b: { type?: string; text?: string }) => (b?.type === "text" ? (b.text ?? "") : "")).join("");
}

/** Parse one session-file line into transcript entries. */
export function entriesOf(line: string): Entry[] {
	let e: { type?: string; customType?: string; content?: unknown; details?: { actors?: { messages?: Message[] } }; message?: { role?: string; content?: unknown; toolName?: string; isError?: boolean } };
	try {
		e = JSON.parse(line);
	} catch {
		return [];
	}
	if (e.type === "custom_message" && e.customType === "pi-actors") {
		const body = text(e.content);
		const msgs = e.details?.actors?.messages;
		return [{ kind: "delivery", summary: Array.isArray(msgs) && msgs.length ? summarizeDelivery(msgs) : body.split("\n")[0], text: body }];
	}
	if (e.type !== "message" || !e.message) return [];
	const m = e.message;
	if (m.role === "user") return [{ kind: "user", text: text(m.content) }];
	if (m.role === "toolResult") return [{ kind: "result", name: m.toolName ?? "tool", text: text(m.content), error: !!m.isError }];
	if (m.role !== "assistant") return [];
	const out: Entry[] = [];
	for (const b of (Array.isArray(m.content) ? m.content : []) as { type?: string; text?: string; name?: string; arguments?: unknown }[]) {
		if (b?.type === "text" && b.text?.trim()) out.push({ kind: "assistant", text: b.text.trim() });
		else if (b?.type === "toolCall") out.push({ kind: "tool", name: b.name ?? "tool", arg: keyArg(b.arguments) });
	}
	return out;
}

/** Session files only grow: read just the bytes appended since the last look. */
const cache = new Map<string, { ino: number; size: number; rest: Buffer; entries: Entry[] }>();

export function readTranscript(sessionFile: string | undefined): Entry[] {
	if (!sessionFile) return [];
	let size: number;
	let ino: number;
	try {
		({ size, ino } = statSync(sessionFile));
	} catch {
		return [];
	}
	let c = cache.get(sessionFile);
	// A replaced or truncated file is read again from the start.
	if (!c || c.ino !== ino || size < c.size) c = { ino, size: 0, rest: Buffer.alloc(0), entries: [] };
	if (size > c.size) {
		const chunk = Buffer.alloc(size - c.size);
		let n: number;
		try {
			const fd = openSync(sessionFile, "r");
			try {
				n = readSync(fd, chunk, 0, chunk.length, c.size);
			} finally {
				closeSync(fd);
			}
		} catch {
			return c.entries;
		}
		// Split on bytes, so a multi-byte character cut at the end of a read stays whole.
		const all = Buffer.concat([c.rest, chunk.subarray(0, n)]);
		const cut = all.lastIndexOf(0x0a) + 1;
		const lines = all.subarray(0, cut).toString("utf8").split("\n").filter(Boolean);
		c = { ino, size: c.size + n, rest: all.subarray(cut), entries: [...c.entries, ...lines.flatMap(entriesOf)] };
	}
	cache.set(sessionFile, c);
	return c.entries;
}
