// Mailroom: push delivery with exact bookkeeping (design v4, D3 revised).
// Fetched messages are leased by the broker, injected as ONE stamped session entry, and acked
// only once that entry is persisted. The consumed set is rebuilt from the session on start, and
// IDs still being delivered are skipped (the in-flight dedupe found by the property test).

import type { Message } from "../protocol.ts";

export const ENTRY_TYPE = "pi-actors";
const INLINE_LIMIT = 16 * 1024;

export interface Stamp {
	id: string;
	consumed: string[];
	/** The delivered messages themselves, so a duplicate can be cut out of the context (N1). */
	messages: Message[];
}

export interface Fetcher {
	fetch(filter: { all: true }): Promise<Message | null>;
	ack(msgId: string): void;
}

export class Mailroom {
	private readonly self: string;
	private consumed = new Set<string>();
	/** Injected but not yet seen persisted: id -> when it was injected. */
	private inFlight = new Map<string, number>();
	private draining = false;
	private rerun = false;

	constructor(self: string) {
		this.self = self;
	}

	/** Rebuild the consumed set from session entries (custom messages and entries we stamped). */
	restore(entries: readonly unknown[]): void {
		for (const e of entries) {
			const stamp = stampOf(e);
			if (stamp && stamp.id === this.self) for (const id of stamp.consumed) this.consumed.add(id);
		}
	}

	/**
	 * Fetch everything currently deliverable. Already-consumed messages are acked and dropped;
	 * messages still in flight are dropped (their lease came back after a reconnect).
	 */
	async drain(f: Fetcher, max = 50): Promise<Message[]> {
		// A request during a drain is not dropped: the running drain loops once more (F9).
		if (this.draining) {
			this.rerun = true;
			return [];
		}
		this.draining = true;
		try {
			const out: Message[] = [];
			for (let i = 0; i < max; i++) {
				if (i === 0) this.rerun = false;
				const m = await f.fetch({ all: true });
				if (!m) {
					if (!this.rerun) break;
					this.rerun = false;
					continue;
				}
				if (this.consumed.has(m.id)) {
					f.ack(m.id);
					continue;
				}
				if (this.inFlight.has(m.id) || out.some((x) => x.id === m.id)) continue;
				out.push(m);
			}
			const now = Date.now();
			for (const m of out) this.inFlight.set(m.id, now);
			return out;
		} finally {
			this.draining = false;
		}
	}

	/** Called at turn_end / agent_settled with the session's entries: ack what is now persisted. */
	settle(entries: readonly unknown[], f: Fetcher): string[] {
		const acked: string[] = [];
		for (const e of entries) {
			const stamp = stampOf(e);
			if (!stamp || stamp.id !== this.self) continue;
			for (const id of stamp.consumed) {
				if (!this.inFlight.has(id)) continue;
				this.inFlight.delete(id);
				this.consumed.add(id);
				f.ack(id);
				acked.push(id);
			}
		}
		return acked;
	}

	/**
	 * At settle: injected messages whose entry never reached the session were dropped by pi (it
	 * clears its queues on Esc). Forget them so they are fetched and delivered again (F4).
	 */
	reclaim(entries: readonly unknown[], minAgeMs = 5000, now = Date.now()): string[] {
		const persisted = new Set<string>();
		for (const e of entries) {
			const stamp = stampOf(e);
			if (stamp?.id === this.self) for (const id of stamp.consumed) persisted.add(id);
		}
		// Young injections may simply not be saved yet (a push made while the agent settles).
		const lost = [...this.inFlight].filter(([id, at]) => !persisted.has(id) && now - at >= minAgeMs).map(([id]) => id);
		for (const id of lost) this.inFlight.delete(id);
		return lost;
	}

	/** A reload loses everything injected but not persisted: it will be redelivered. */
	forgetInFlight(): void {
		this.inFlight.clear();
	}

	stamp(messages: readonly Message[]): Stamp {
		// Only what formatDelivery shows (one char over the limit keeps its "truncated" note):
		// the session must not store every large body twice. End notices stay whole (JSON).
		const kept = messages.map((m) => (m.kind === "down" || m.body.length <= INLINE_LIMIT ? m : { ...m, body: clean(m.body).slice(0, INLINE_LIMIT + 1) }));
		return { id: this.self, consumed: messages.map((m) => m.id), messages: kept };
	}
}

function stampOf(entry: unknown): Stamp | undefined {
	const e = entry as { type?: string; customType?: string; details?: { actors?: Stamp }; message?: { details?: { actors?: Stamp } } };
	const s = e?.details?.actors ?? e?.message?.details?.actors;
	return s && typeof s.id === "string" && Array.isArray(s.consumed) ? s : undefined;
}

/**
 * The last line of defence for "consumed at most once" (N1): before every model request, drop
 * messages whose id already appeared earlier in this agent's context. A push can reach the
 * session twice when pi keeps a queued injection that a reclaim also redelivered; the model sees
 * it once. Partially duplicated entries are rebuilt from what is left.
 */
export function dedupeContext<T>(self: string, messages: readonly T[]): T[] | undefined {
	const seen = new Set<string>();
	let changed = false;
	const out: T[] = [];
	for (const msg of messages) {
		const m = msg as { role?: string; customType?: string; details?: { actors?: Stamp } };
		const stamp = m.role === "custom" && m.customType === ENTRY_TYPE ? m.details?.actors : undefined;
		// A stamp without its messages (an unreleased early build) cannot be rebuilt: leave it be.
		if (!stamp || stamp.id !== self || !Array.isArray(stamp.messages)) {
			out.push(msg);
			continue;
		}
		const fresh = stamp.consumed.filter((id) => !seen.has(id));
		for (const id of stamp.consumed) seen.add(id);
		if (fresh.length === stamp.consumed.length) {
			out.push(msg);
			continue;
		}
		changed = true;
		if (fresh.length === 0) continue;
		const keep = stamp.messages.filter((x) => fresh.includes(x.id));
		out.push({ ...msg, content: formatDelivery(self, keep), details: { actors: { ...stamp, consumed: fresh, messages: keep } } } as T);
	}
	return changed ? out : undefined;
}

const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");

/** Human-readable body for one pushed entry. Sender-labelled; never phrased as user input. */
export function formatDelivery(self: string, messages: readonly Message[]): string {
	const lines = [`[pi-actors] ${messages.length} update${messages.length === 1 ? "" : "s"} for ${self}:`];
	for (const m of messages) {
		// Shown in the TUI too: no terminal control sequences from other agents (N7).
		const safe = clean(m.body);
		const body = safe.length > INLINE_LIMIT ? `${safe.slice(0, INLINE_LIMIT)}\n…(truncated; ask the sender for the rest or for a file path)` : safe;
		if (m.kind === "down") {
			const d = safeJson(m.body) as { id?: string; reason?: string; result?: string } | undefined;
			lines.push(`\n■ ${d?.id ?? "?"} has ended: ${d?.reason ?? "?"}${d?.result ? `\nIts result:\n${clean(d.result)}` : ""}`);
		} else if (m.tag === "task") {
			lines.push(`\n■ Task from ${m.from} (msg ${m.id}):\n${body}`);
		} else if (m.tag === "report") {
			lines.push(`\n■ Report from ${m.from} (it finished a run; send it a message to continue it):\n${body}`);
		} else if (m.kind === "reply" || m.ref) {
			lines.push(`\n■ ${m.from === "human" ? "The human" : m.from} answered your message ${m.ref ?? "?"} (msg ${m.id}):\n${body}`);
		} else {
			lines.push(`\n■ Message from ${m.from} (msg ${m.id}${m.urgent ? ", urgent" : ""}):\n${body}`);
		}
	}
	lines.push("\nReply with send{to, text, reply_to: <msg>} when an answer is needed.");
	return lines.join("\n");
}

function safeJson(s: string): unknown {
	try {
		return JSON.parse(s);
	} catch {
		return undefined;
	}
}
