// Client: an agent's connection to its tree's broker (design: Identity, Data flow).
// Sender sequence numbers make retransmits idempotent; unanswered frames are re-sent in order
// after a reconnect; the connection is retried until the link grace runs out.

import { EventEmitter } from "node:events";
import { connect, type Socket } from "node:net";
import { decode, encode, LIMITS, type Message, type MessageKind, PROTO, type Response, TIMING } from "../protocol.ts";

export interface Identity {
	socket: string;
	id: string;
	inc: number;
	pid: number;
	sessionId?: string;
	sessionFile?: string;
}

export interface FetchFilter {
	all?: boolean;
	kind?: MessageKind;
	from?: string;
	tag?: string;
	ref?: string;
	human?: boolean;
}

export interface Snapshot {
	treeId: string;
	self: string;
	agents: { id: string; parent: string | null; status: string; inc: number; reason?: string; connected: boolean; placement?: string; model?: string; mailbox: number; spawns: number; sessionFile?: string; task?: string }[];
	human: { ref?: string; from: string; body: string; fromPane?: boolean }[];
	pendingCalls: string[];
	liveChildren: number;
}

type OpFrame = { t: "op"; seq: number; op: string } & Record<string, unknown>;

/**
 * Events: "welcome", "mail" (urgent, humanPending), "terminate" (reason), "superseded",
 * "rejected" (reason), "lost" (no broker within the grace period).
 */
export class Client extends EventEmitter {
	private sock: Socket | undefined;
	private buf = "";
	private nextSeq = 1;
	private inflight: OpFrame[] = [];
	private waiters = new Map<number, (r: Response) => void>();
	private fetches = new Map<string, (m: Message | null) => void>();
	private inspects = new Map<string, (s: Snapshot) => void>();
	private counter = 0;
	private closed = false;
	private lostSince: number | undefined;
	private hb: NodeJS.Timeout | undefined;
	connected = false;
	usage: () => Record<string, number> | undefined = () => undefined;

	readonly identity: Identity;
	private readonly graceMs: number;
	/** Runs before every reconnect attempt: the root relaunches its broker here (F10). */
	private readonly redial: (() => Promise<void>) | undefined;

	constructor(identity: Identity, graceMs: number = TIMING.childGraceMs, redial?: () => Promise<void>) {
		super();
		this.identity = identity;
		this.graceMs = graceMs;
		this.redial = redial;
	}

	get isClosed(): boolean {
		return this.closed;
	}

	/** Closed for good: settle everything still waiting, so no tool call hangs (F2). */
	private shut(reason: string) {
		this.closed = true;
		clearInterval(this.hb);
		for (const [, w] of this.waiters) w({ ok: false, error: "not_live", detail: reason });
		this.waiters.clear();
		this.inflight = [];
		for (const [, r] of this.fetches) r(null);
		this.fetches.clear();
	}

	/** Connect and resolve on the first welcome; rejects on an identity rejection. */
	start(): Promise<void> {
		return new Promise((resolve, reject) => {
			const onWelcome = () => {
				this.off("rejected", onReject);
				resolve();
			};
			const onReject = (reason: string) => {
				this.off("welcome", onWelcome);
				reject(new Error(`rejected: ${reason}`));
			};
			this.once("welcome", onWelcome);
			this.once("rejected", onReject);
			this.dial();
		});
	}

	private dial() {
		if (this.closed) return;
		const s = connect(this.identity.socket);
		s.setEncoding("utf8");
		s.on("connect", () => {
			this.sock = s;
			this.buf = "";
			const { socket: _s, ...id } = this.identity;
			this.write({ t: "hello", proto: PROTO, ...id });
		});
		s.on("data", (d: string) => this.onData(d));
		s.on("error", () => {});
		s.on("close", () => {
			if (this.sock === s) this.sock = undefined;
			const was = this.connected;
			this.connected = false;
			clearInterval(this.hb);
			for (const [, r] of this.fetches) r(null); // leases die with the connection
			this.fetches.clear();
			if (was) this.emit("disconnected");
			if (this.closed) return;
			this.lostSince ??= Date.now();
			if (Date.now() - this.lostSince > this.graceMs) {
				this.shut("broker unreachable");
				return void this.emit("lost");
			}
			const delay = Math.min(5000, 500 * 2 ** Math.min(4, this.counter++ % 5));
			setTimeout(() => {
				if (this.redial) void this.redial().catch(() => {}).finally(() => this.dial());
				else this.dial();
			}, delay).unref();
		});
	}

	private onData(d: string) {
		const { frames, rest } = decode(this.buf + d);
		this.buf = rest;
		for (const f of frames as Record<string, any>[]) {
			switch (f.t) {
				case "welcome":
					this.connected = true;
					this.lostSince = undefined;
					this.counter = 0;
					if (this.inflight.length === 0) this.nextSeq = f.lastSeq + 1;
					for (const op of this.inflight) this.write(op); // retransmit in order
					clearInterval(this.hb);
					this.hb = setInterval(() => this.write({ t: "hb", usage: this.usage() }), TIMING.heartbeatMs);
					this.hb.unref();
					this.emit("welcome", f);
					break;
				case "resp": {
					this.inflight = this.inflight.filter((x) => x.seq !== f.seq);
					const w = this.waiters.get(f.seq);
					this.waiters.delete(f.seq);
					w?.(f.response);
					break;
				}
				case "fetched": {
					const r = this.fetches.get(f.fetchId);
					this.fetches.delete(f.fetchId);
					r?.(f.message ?? null);
					break;
				}
				case "inspect": {
					const r = this.inspects.get(f.reqId);
					this.inspects.delete(f.reqId);
					r?.(f.state);
					break;
				}
				case "mail":
					this.emit("mail", !!f.urgent, f.human ?? 0);
					break;
				case "terminate":
					this.emit("terminate", f.reason);
					break;
				case "superseded":
					this.shut("superseded");
					this.emit("superseded");
					break;
				case "reject":
				case "proto_mismatch": {
					const reason = f.t === "reject" ? f.reason : `protocol ${f.client} vs broker ${f.broker}`;
					this.shut(`rejected: ${reason}`);
					this.emit("rejected", reason);
					break;
				}
			}
		}
	}

	private write(frame: object) {
		if (this.sock && !this.sock.destroyed) this.sock.write(encode(frame));
	}

	/** A sequenced operation (spawn, send, answer, exit, kill); idempotent across reconnects. */
	op(op: string, fields: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
		if (this.closed) return Promise.resolve({ ok: false, error: "not_live", detail: "connection closed" });
		// Size first: an oversized frame must not consume a sequence number (F8).
		if (Buffer.byteLength(JSON.stringify(fields)) > LIMITS.frameBytes + 4096) {
			return Promise.resolve({ ok: false, error: "too_large", detail: `over ${LIMITS.frameBytes} bytes; write it to a file and send the path` });
		}
		const frame: OpFrame = { t: "op", seq: this.nextSeq++, op, ...fields };
		this.inflight.push(frame);
		const p = new Promise<Response>((resolve) => {
			this.waiters.set(frame.seq, resolve);
			// Aborting stops waiting; the frame stays queued (sequence order) and its effect may still happen.
			signal?.addEventListener("abort", () => {
				if (this.waiters.delete(frame.seq)) resolve({ ok: false, error: "not_live", detail: "aborted" });
			}, { once: true });
		});
		if (this.connected) this.write(frame);
		return p;
	}

	/** Lease the next matching message (null if none, or if the connection drops meanwhile). */
	fetch(filter: FetchFilter = {}): Promise<Message | null> {
		if (!this.connected) return Promise.resolve(null);
		const fetchId = `f${++this.counter}-${Date.now()}`;
		const p = new Promise<Message | null>((resolve) => this.fetches.set(fetchId, resolve));
		this.write({ t: "fetch", fetchId, ...filter });
		return p;
	}

	ack(msgId: string, human = false) {
		this.write({ t: "ack", msgId, human });
	}

	release(msgId: string) {
		this.write({ t: "release", msgId });
	}

	inspect(): Promise<Snapshot | undefined> {
		if (!this.connected) return Promise.resolve(undefined);
		const reqId = `i${++this.counter}`;
		const p = new Promise<Snapshot>((resolve) => this.inspects.set(reqId, resolve));
		this.write({ t: "inspect", reqId });
		return Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), 5000).unref())]);
	}

	/** Resolve on the next mail notice or after `ms`, without leaking listeners. */
	waitForMail(ms: number, signal?: AbortSignal): Promise<void> {
		return new Promise((resolve) => {
			const done = () => {
				clearTimeout(t);
				this.off("mail", done);
				this.off("welcome", done);
				signal?.removeEventListener("abort", done);
				resolve();
			};
			const t = setTimeout(done, ms);
			this.on("mail", done);
			this.on("welcome", done);
			signal?.addEventListener("abort", done, { once: true });
		});
	}

	stopTree() {
		this.write({ t: "stop_tree" });
	}

	/** Leave; the broker treats the drop as a disconnect (grace applies). */
	close(reason: "reload" | "quit" = "quit") {
		this.write({ t: "bye", reason });
		this.shut("closed");
		this.sock?.end();
	}
}
