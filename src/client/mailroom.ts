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
}

export interface Fetcher {
	fetch(filter: { all: true }): Promise<Message | null>;
	ack(msgId: string): void;
}

export class Mailroom {
	private readonly self: string;
	private consumed = new Set<string>();
	/** Injected but not yet seen persisted. */
	private inFlight = new Set<string>();
	private draining = false;

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
		if (this.draining) return [];
		this.draining = true;
		try {
			const out: Message[] = [];
			for (let i = 0; i < max; i++) {
				const m = await f.fetch({ all: true });
				if (!m) break;
				if (this.consumed.has(m.id)) {
					f.ack(m.id);
					continue;
				}
				if (this.inFlight.has(m.id) || out.some((x) => x.id === m.id)) continue;
				out.push(m);
			}
			for (const m of out) this.inFlight.add(m.id);
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

	/** A reload loses everything injected but not persisted: it will be redelivered. */
	forgetInFlight(): void {
		this.inFlight.clear();
	}

	stamp(messages: readonly Message[]): Stamp {
		return { id: this.self, consumed: messages.map((m) => m.id) };
	}
}

function stampOf(entry: unknown): Stamp | undefined {
	const e = entry as { type?: string; customType?: string; details?: { actors?: Stamp }; message?: { details?: { actors?: Stamp } } };
	const s = e?.details?.actors ?? e?.message?.details?.actors;
	return s && typeof s.id === "string" && Array.isArray(s.consumed) ? s : undefined;
}

/** Human-readable body for one pushed entry. Sender-labelled; never phrased as user input. */
export function formatDelivery(self: string, messages: readonly Message[]): string {
	const lines = [`[pi-actors] ${messages.length} update${messages.length === 1 ? "" : "s"} for ${self}:`];
	for (const m of messages) {
		const body = m.body.length > INLINE_LIMIT ? `${m.body.slice(0, INLINE_LIMIT)}\n…(truncated; ask the sender for the rest or for a file path)` : m.body;
		if (m.kind === "down") {
			const d = safeJson(m.body) as { id?: string; reason?: string; result?: string } | undefined;
			lines.push(`\n■ ${d?.id ?? "?"} has ended: ${d?.reason ?? "?"}${d?.result ? `\nIts result:\n${d.result}` : ""}`);
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
