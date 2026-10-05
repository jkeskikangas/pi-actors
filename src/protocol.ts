// Wire protocol: shared types, limits and NDJSON framing. Pure: imports nothing (conformance rule).

export const PROTO = 1;

export const LIMITS = {
	/** Largest encoded frame, and the largest message body or exit result. */
	frameBytes: 64 * 1024,
	/** Ordinary mail per agent. */
	mailboxCount: 200,
	mailboxBytes: 2 * 1024 * 1024,
	/** Exempt kinds (DOWN, reply) per agent: obligations held plus queued exempt messages. */
	reserve: 400,
	/** Responses cached per sender incarnation for idempotent retransmits. */
	idempotencyWindow: 256,
	maxResumes: 3,
} as const;

export const TIMING = {
	childGraceMs: 60_000,
	rootGraceMs: 300_000,
	startMs: 120_000,
	exitingMs: 10_000,
	/** Kill escalation: terminate at 0, TERM at +5 s, KILL at +10 s, give up at +15 s. */
	killTermMs: 5_000,
	killKillMs: 10_000,
	killGiveUpMs: 15_000,
	heartbeatMs: 15_000,
	heartbeatTimeoutMs: 45_000,
} as const;

export const DEFAULT_LIMITS: Limits = { maxDepth: 2, maxSpawns: 40 };

export interface Limits {
	maxDepth: number;
	maxSpawns: number;
}

export type MessageKind = "mail" | "call" | "reply" | "down";
export type Placement = "headless" | "pane";
export type Context = "fresh" | "fork";

export interface Message {
	id: string;
	from: string;
	to: string;
	kind: MessageKind;
	body: string;
	tag?: string;
	/** For `call`: its own id (the ref to answer). For `reply`: the call it answers. */
	ref?: string;
	urgent?: boolean;
}

export type ErrorCode =
	| "unknown_target"
	| "target_down"
	| "mailbox_full"
	| "reply_reserve_full"
	| "limit_depth"
	| "budget_exhausted"
	| "not_authorized"
	| "not_live"
	| "stale_ref"
	| "seq_gap"
	| "too_large"
	| "bad_request";

export type Response =
	| { ok: true; type: "spawned"; id: string; inc: number }
	| { ok: true; type: "accepted"; msgId: string }
	| { ok: true; type: "done" }
	| { ok: false; error: ErrorCode; detail?: string };

/** Encode one frame as a line. Throws `too_large` beyond the frame limit. */
export function encode(frame: unknown): string {
	const line = JSON.stringify(frame);
	if (Buffer.byteLength(line) > LIMITS.frameBytes * 2) throw new Error("too_large");
	return `${line}\n`;
}

/** Split a buffer into complete lines; returns the frames and the incomplete remainder. */
export function decode(buffer: string): { frames: unknown[]; rest: string } {
	const parts = buffer.split("\n");
	const rest = parts.pop() ?? "";
	const frames: unknown[] = [];
	for (const p of parts) {
		const line = p.endsWith("\r") ? p.slice(0, -1) : p;
		if (!line) continue;
		try {
			frames.push(JSON.parse(line));
		} catch {
			frames.push({ type: "invalid" });
		}
	}
	return { frames, rest };
}

export function byteLength(s: string): number {
	let n = 0;
	for (const ch of s) {
		const c = ch.codePointAt(0) ?? 0;
		n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
	}
	return n;
}
