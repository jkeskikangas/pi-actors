// The agents panel: questions for the human and the agent tree, opened with ↓ on an empty editor.
// The state machine is pure (unit-tested); index.ts wraps it in a pi-tui component.

import { readFileSync } from "node:fs";
import type { Snapshot } from "./connection.ts";

export type PanelItem =
	| { kind: "question"; ref: string; from: string; body: string }
	| { kind: "agent"; id: string; status: string; reason?: string; model?: string; placement?: string; mailbox: number; sessionFile?: string; task?: string; depth: number };

export type PanelKey = "up" | "down" | "enter" | "escape" | "focus";

export type PanelAction =
	| { type: "none" }
	| { type: "close" }
	| { type: "answer"; ref: string; from: string; body: string }
	| { type: "focusPane"; id: string };

export interface PanelState {
	items: PanelItem[];
	selected: number;
	/** Agent whose transcript is shown, if any. */
	viewing?: string;
}

const ACTIVE = new Set(["starting", "live", "disconnected", "exiting", "killing"]);

/** Questions first (they need you), then the tree in parent order, root excluded. */
export function itemsFrom(snap: Snapshot): PanelItem[] {
	const questions: PanelItem[] = snap.human.filter((q) => q.ref).map((q) => ({ kind: "question", ref: q.ref!, from: q.from, body: q.body }));
	const byParent = new Map<string | null, Snapshot["agents"]>();
	for (const a of snap.agents) byParent.set(a.parent, [...(byParent.get(a.parent) ?? []), a]);
	const agents: PanelItem[] = [];
	const walk = (parent: string, depth: number) => {
		for (const a of byParent.get(parent) ?? []) {
			agents.push({ kind: "agent", id: a.id, status: a.status, reason: a.reason, model: a.model, placement: a.placement, mailbox: a.mailbox, sessionFile: a.sessionFile, task: a.task, depth });
			walk(a.id, depth + 1);
		}
	};
	walk("root", 0);
	return [...questions, ...agents];
}

export function summary(snap: Snapshot | undefined): string | undefined {
	if (!snap) return undefined;
	// Agents that have not ended; an idle child that already reported still counts (it can be continued).
	const agents = snap.agents.filter((a) => a.id !== "root" && ACTIVE.has(a.status)).length;
	const questions = snap.human.length;
	if (agents === 0 && questions === 0) return undefined;
	const parts = [`pi-actors · ${agents} agent${agents === 1 ? "" : "s"}`];
	if (questions) parts.push(`${questions} question${questions === 1 ? "" : "s"} for you`);
	return `${parts.join(" · ")} — ↓ to open`;
}

export function press(st: PanelState, key: PanelKey): { state: PanelState; action: PanelAction } {
	if (st.viewing) {
		if (key === "escape" || key === "enter") return { state: { ...st, viewing: undefined }, action: { type: "none" } };
		if (key === "focus") return { state: st, action: { type: "focusPane", id: st.viewing } };
		return { state: st, action: { type: "none" } };
	}
	const n = st.items.length;
	switch (key) {
		case "up":
			return { state: { ...st, selected: n ? (st.selected - 1 + n) % n : 0 }, action: { type: "none" } };
		case "down":
			return { state: { ...st, selected: n ? (st.selected + 1) % n : 0 }, action: { type: "none" } };
		case "escape":
			return { state: st, action: { type: "close" } };
		case "focus": {
			const it = st.items[st.selected];
			return { state: st, action: it?.kind === "agent" && it.placement === "pane" ? { type: "focusPane", id: it.id } : { type: "none" } };
		}
		case "enter": {
			const it = st.items[st.selected];
			if (!it) return { state: st, action: { type: "close" } };
			if (it.kind === "question") return { state: st, action: { type: "answer", ref: it.ref, from: it.from, body: it.body } };
			return { state: { ...st, viewing: it.id }, action: { type: "none" } };
		}
	}
}

/** Plain-text lines (no styling): index.ts colours them. Width-limited by the caller. */
export function render(st: PanelState, transcript: (item: Extract<PanelItem, { kind: "agent" }>) => string[]): string[] {
	if (st.viewing) {
		const it = st.items.find((x): x is Extract<PanelItem, { kind: "agent" }> => x.kind === "agent" && x.id === st.viewing);
		const head = `── ${st.viewing} · ${it?.status ?? "?"}${it?.model ? ` · ${it.model}` : ""} ──  (esc back${it?.placement === "pane" ? " · f focus pane" : ""})`;
		return [head, ...(it ? transcript(it) : ["(gone)"])];
	}
	if (st.items.length === 0) return ["pi-actors: nothing to show  (esc close)"];
	const panes = st.items.some((it) => it.kind === "agent" && it.placement === "pane");
	const lines = [`pi-actors  (↑↓ move · enter open/answer${panes ? " · f focus pane" : ""} · esc close)`];
	st.items.forEach((it, i) => {
		const cursor = i === st.selected ? "❯ " : "  ";
		if (it.kind === "question") lines.push(`${cursor}? ${it.from} asks: ${oneLine(it.body)}`);
		else lines.push(`${cursor}${"  ".repeat(it.depth)}${it.id} · ${it.status}${it.reason ? ` (${it.reason})` : ""}${it.model ? ` · ${it.model}` : ""}${it.placement === "pane" ? " · pane" : ""}${it.mailbox ? ` · ${it.mailbox} queued` : ""}`);
	});
	return lines;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").slice(0, 160);

/** Last messages of an agent's session file: what it was asked, what it did, what it said. */
export function readTranscript(sessionFile: string | undefined, max = 30): string[] {
	if (!sessionFile) return ["(no session file yet)"];
	let raw: string;
	try {
		raw = readFileSync(sessionFile, "utf8");
	} catch {
		return ["(session file not readable yet)"];
	}
	const out: string[] = [];
	for (const line of raw.split("\n")) {
		if (!line) continue;
		let e: { type?: string; customType?: string; content?: unknown; message?: { role?: string; content?: unknown; toolName?: string } };
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		if (e.type === "custom_message" && e.customType === "pi-actors") out.push(`⇢ ${oneLine(text(e.content))}`);
		else if (e.type === "message" && e.message) {
			const m = e.message;
			if (m.role === "user") out.push(`user: ${oneLine(text(m.content))}`);
			else if (m.role === "assistant") {
				const parts = Array.isArray(m.content) ? m.content : [];
				const said = text(m.content);
				for (const b of parts as { type?: string; name?: string }[]) if (b?.type === "toolCall") out.push(`  ⚙ ${b.name}`);
				if (said.trim()) out.push(`assistant: ${oneLine(said)}`);
			} else if (m.role === "toolResult") out.push(`  ↳ ${m.toolName ?? "tool"}: ${oneLine(text(m.content)).slice(0, 100)}`);
		}
	}
	return out.length ? out.slice(-max) : ["(nothing yet)"];
}

function text(c: unknown): string {
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return "";
	return c.map((b: { type?: string; text?: string }) => (b?.type === "text" ? (b.text ?? "") : "")).join("");
}
