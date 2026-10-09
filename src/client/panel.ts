// The agents panel: the agent tree and each agent's transcript, opened with ↓ on an empty editor.
// The state machine is pure (unit-tested); index.ts wraps it in a pi-tui component.

import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Snapshot } from "./connection.ts";

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

/** `none`: the line is styled already (a transcript line). */
export type Tone = "accent" | "text" | "muted" | "dim" | "none";
export interface Line {
	text: string;
	tone: Tone;
}
export interface View {
	head: Line;
	body: Line[];
	foot: Line;
	/** The transcript scroll offset clamped to the transcript, so the caller keeps a reachable value. */
	scroll: number;
	seen?: number;
}

/**
 * The panel as toned lines that fit `width` (styling is index.ts's): a head, `height` body lines at
 * most, and a foot with the keys. The list is as tall as its rows; a transcript fills `height`.
 * `transcript` returns an agent's transcript as styled lines that fit the screen.
 */
export function view(st: PanelState, width: number, height: number, transcript: (it: AgentItem, width: number) => string[]): View {
	const fit = (text: string, tone: Tone): Line => ({ text: truncateToWidth(text, width, "…"), tone });
	const room = Math.max(1, height);
	if (st.viewing) {
		const it = viewed(st);
		const keys = ["↑↓ PgUp/PgDn scroll", `e ${st.expanded ? "collapse" : "expand"}`, ...(focusable(it) ? ["f focus pane"] : []), ...(it?.clearable ? ["x clear"] : []), "esc back"];
		const lines = it ? transcript(it, width) : [];
		while (lines.length && lines.at(-1)!.trim() === "") lines.pop();
		const grown = st.scroll > 0 && st.seen !== undefined ? Math.max(0, lines.length - st.seen) : 0;
		const scroll = Math.min(st.scroll + grown, Math.max(0, lines.length - room));
		const end = lines.length - scroll;
		// Transcript lines come laid out for the screen already.
		const shown = lines.slice(Math.max(0, end - room), end).map((text): Line => ({ text, tone: "none" }));
		const body = shown.length ? shown : [fit(" (nothing yet)", "dim")];
		while (body.length < room) body.push({ text: "", tone: "none" });
		const below = scroll > 0 ? [`↓ ${scroll} more line${scroll === 1 ? "" : "s"} (End to follow)`] : [];
		return { head: fit(it ? agentLine(it) : `${st.viewing} (gone)`, "accent"), body, foot: fit([...below, ...keys].join(" · "), "dim"), scroll, seen: lines.length };
	}
	const rows = items(st);
	if (rows.length === 0) return { head: fit("pi-actors", "accent"), body: [fit("  no agents", "dim")], foot: fit("esc close", "dim"), scroll: 0 };
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
	// Keep the cursor visible in a short list.
	const start = Math.min(Math.max(0, st.selected - room + 1), Math.max(0, lines.length - room));
	return { head: fit("pi-actors", "accent"), body: lines.slice(start, start + room), foot: fit(keys.join(" · "), "dim"), scroll: 0 };
}
