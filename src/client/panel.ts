// The agents panel: questions for the human and the agent tree, opened with ↓ on an empty editor.
// The state machine is pure (unit-tested); index.ts wraps it in a pi-tui component.

import { readFileSync } from "node:fs";
import type { Snapshot } from "./connection.ts";

export type PanelItem =
	| { kind: "question"; ref: string; from: string; body: string }
	| { kind: "agent"; id: string; status: string; reason?: string; model?: string; placement?: string; mailbox: number; sessionFile?: string; task?: string; depth: number };

export type PanelKey = "up" | "down" | "enter" | "escape" | "focus" | "space" | "decline" | "transcript";

// ---------------------------------------------------------------- rich questions

export interface Choice {
	label: string;
	description?: string;
}

export interface Question {
	text: string;
	choices: Choice[];
	multi: boolean;
}

const QUESTION_TAG = "pi_actors_question";
export const OTHER = "Type something…";

/**
 * A question to the human travels as the message body, always encoded: plain text that merely
 * looks like an encoded question can then never be mistaken for one (N7).
 */
export function encodeQuestion(text: string, choices: (string | Choice)[] = [], multi = false): string {
	const norm = choices.map((c) => (typeof c === "string" ? { label: c } : c));
	return JSON.stringify({ [QUESTION_TAG]: 1, text, choices: norm, multi });
}

export function parseQuestion(body: string): Question {
	try {
		const q = JSON.parse(body);
		if (q?.[QUESTION_TAG] === 1) {
			// Only well-formed choices: an object with a string label (N7).
			const choices = (Array.isArray(q.choices) ? q.choices : [])
				.filter((c: unknown): c is Choice => !!c && typeof c === "object" && typeof (c as Choice).label === "string")
				.map((c: Choice) => (typeof c.description === "string" ? { label: clean(c.label), description: clean(c.description) } : { label: clean(c.label) }));
			return { text: clean(String(q.text ?? "")), choices, multi: !!q.multi };
		}
	} catch {
		// plain text
	}
	return { text: clean(body), choices: [], multi: false };
}

/** Agent-supplied text is shown in the terminal: strip control characters except newline and tab. */
export function clean(s: string): string {
	return s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

/** The answer as the agent reads it: unambiguous plain text. */
export function formatAnswer(q: Question, picked: string[], text?: string): string {
	const lines: string[] = [];
	if (picked.length) lines.push(`${q.multi ? "Selected" : "Chose"}: ${picked.join(", ")}`);
	if (text?.trim()) lines.push(picked.length ? `Note: ${text.trim()}` : text.trim());
	return lines.join("\n") || "(no answer)";
}

export const DECLINED = "The human declined to answer this; use your own judgment and say what you decided.";

export interface Card {
	ref: string;
	from: string;
	task?: string;
	q: Question;
	/** Index into choices; choices.length is the "Type something…" row. */
	cursor: number;
	picked: number[];
}

export function openCard(item: Extract<PanelItem, { kind: "question" }>, task?: string): Card {
	return { ref: item.ref, from: item.from, task, q: parseQuestion(item.body), cursor: 0, picked: [] };
}

export type PanelAction =
	| { type: "none" }
	| { type: "close" }
	| { type: "answer"; ref: string; from: string; body: string }
	/** Free text still needed: the caller asks for it, then sends formatAnswer(q, picked, text). */
	| { type: "freeText"; ref: string; from: string; q: Question; picked: string[] }
	| { type: "focusPane"; id: string };

export interface PanelState {
	items: PanelItem[];
	selected: number;
	/** Agent whose transcript is shown, if any. */
	viewing?: string;
	/** The question being answered, if any. */
	card?: Card;
}

function pressCard(st: PanelState, card: Card, key: PanelKey): { state: PanelState; action: PanelAction } {
	const rows = card.q.choices.length + 1; // + "Type something…"
	const onOther = card.cursor === card.q.choices.length;
	const labels = () => card.picked.map((i) => card.q.choices[i].label);
	const keep = (c: Card) => ({ state: { ...st, card: c }, action: { type: "none" } as PanelAction });
	switch (key) {
		case "up":
			return keep({ ...card, cursor: (card.cursor - 1 + rows) % rows });
		case "down":
			return keep({ ...card, cursor: (card.cursor + 1) % rows });
		case "space":
			if (!card.q.multi || onOther) return keep(card);
			return keep({ ...card, picked: card.picked.includes(card.cursor) ? card.picked.filter((i) => i !== card.cursor) : [...card.picked, card.cursor].sort((a, b) => a - b) });
		case "escape":
			return { state: { ...st, card: undefined }, action: { type: "none" } };
		case "decline":
			return { state: st, action: { type: "answer", ref: card.ref, from: card.from, body: DECLINED } };
		case "transcript":
			return { state: { ...st, viewing: card.from }, action: { type: "none" } };
		case "enter": {
			if (onOther) return { state: st, action: { type: "freeText", ref: card.ref, from: card.from, q: card.q, picked: card.q.multi ? labels() : [] } };
			if (card.q.multi) {
				const picked = card.picked.length ? labels() : [card.q.choices[card.cursor].label];
				return { state: st, action: { type: "answer", ref: card.ref, from: card.from, body: formatAnswer(card.q, picked) } };
			}
			return { state: st, action: { type: "answer", ref: card.ref, from: card.from, body: formatAnswer(card.q, [card.q.choices[card.cursor].label]) } };
		}
		default:
			return keep(card);
	}
}

export function renderCard(card: Card): string[] {
	// Keys first: in a short pane the bottom of an overlay can be cut off.
	const lines = [
		`${card.from} asks${card.task ? ` (working on: ${card.task.replace(/\s+/g, " ").slice(0, 80)})` : ""}  (↑↓ move${card.q.multi ? " · space toggle · enter confirm" : " · enter choose"} · t transcript · d decline · esc back)`,
		"",
	];
	for (const l of card.q.text.split("\n")) lines.push(`  ${l}`);
	lines.push("");
	const rows = [...card.q.choices.map((c) => ({ ...c })), { label: OTHER }];
	rows.forEach((c, i) => {
		const cursor = i === card.cursor ? "❯ " : "  ";
		const box = card.q.multi && i < card.q.choices.length ? (card.picked.includes(i) ? "[x] " : "[ ] ") : "";
		lines.push(`${cursor}${box}${c.label}${"description" in c && c.description ? ` — ${c.description}` : ""}`);
	});
	return lines;
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
	if (st.card && !st.viewing) return pressCard(st, st.card, key);
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
			if (it.kind === "question") {
				const asker = st.items.find((x) => x.kind === "agent" && x.id === it.from);
				return { state: { ...st, card: openCard(it, asker?.kind === "agent" ? asker.task : undefined) }, action: { type: "none" } };
			}
			return { state: { ...st, viewing: it.id }, action: { type: "none" } };
		}
		default:
			return { state: st, action: { type: "none" } };
	}
}

/** Plain-text lines (no styling): index.ts colours them. Width-limited by the caller. */
export function render(st: PanelState, transcript: (item: Extract<PanelItem, { kind: "agent" }>) => string[]): string[] {
	if (st.card && !st.viewing) return renderCard(st.card);
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
		if (it.kind === "question") lines.push(`${cursor}? ${it.from} asks: ${oneLine(parseQuestion(it.body).text)}`);
		else lines.push(`${cursor}${"  ".repeat(it.depth)}${it.id} · ${it.status}${it.reason ? ` (${it.reason})` : ""}${it.model ? ` · ${it.model}` : ""}${it.placement === "pane" ? " · pane" : ""}${it.mailbox ? ` · ${it.mailbox} queued` : ""}`);
	});
	return lines;
}

const oneLine = (s: string) => clean(s).replace(/\s+/g, " ").slice(0, 160);

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
