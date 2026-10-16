// Client: an agent's connection to its tree's broker (design: Identity, Data flow).
// Sender sequence numbers make retransmits idempotent; unanswered frames are re-sent in order
// after a reconnect; the connection is retried until the link grace runs out. A broker that
// stops answering counts as gone: silence, or any request unanswered, for the heartbeat timeout
// drops the connection, and the reconnect recovers (issue #5).

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
}

export interface Snapshot {
	treeId: string;
	self: string;
	/** `running`: executing a run (not idle) on its current connection; absent from older brokers. */
	agents: { id: string; parent: string | null; status: string; inc: number; reason?: string; connected: boolean; running?: boolean; placement?: string; paneId?: string; model?: string; fast?: boolean; mailbox: number; spawns: number; sessionFile?: string; task?: string }[];
	liveChildren: number;
}

type OpFrame = { t: "op"; seq: number; op: string } & Record<string, unknown>;

const WATCHDOG_MS = 1000;
/** A check this late ran after a sleep or a blocked event loop: it measured us, not the broker. */
const LATE_MS = 5000;

/**
 * Events: "welcome", "mail" (urgent), "terminate" (reason), "superseded",
 * "rejected" (reason), "lost" (no broker within the grace period).
 */
export class Client extends EventEmitter {
	private sock: Socket | undefined;
	private buf = "";
	private nextSeq = 1;
	private inflight: OpFrame[] = [];
	/** In-flight frames the broker refused with seq_gap (not applied): held for a resend in order. */
	private gapped = new Set<number>();
	private waiters = new Map<number, (r: Response) => void>();
	private fetches = new Map<string, (m: Message | null) => void>();
	private inspects = new Map<string, (s: Snapshot) => void>();
	private counter = 0;
	private closed = false;
	private lostSince: number | undefined;
	private hb: NodeJS.Timeout | undefined;
	/** When this connection last heard the broker, and what it still owes: request -> when asked. */
	private heard = 0;
	private owed = new Map<string, number>();
	private watchdog: NodeJS.Timeout | undefined;
	private checked = 0;
	private running = false;
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
		clearInterval(this.watchdog);
		for (const [, w] of this.waiters) w({ ok: false, error: "not_live", detail: reason });
		this.waiters.clear();
		this.inflight = [];
		this.gapped.clear();
		for (const [, r] of this.fetches) r(null);
		this.fetches.clear();
	}

	/** Connect and resolve on the first welcome; rejects on an identity rejection. */
	start(): Promise<void> {
		return new Promise((resolve, reject) => {
			// Every way this connection can end before the first welcome settles start() (N3).
			const cleanup = () => {
				this.off("welcome", onWelcome);
				this.off("rejected", onReject);
				this.off("lost", onLost);
				this.off("superseded", onSuperseded);
			};
			const onWelcome = () => (cleanup(), resolve());
			const onReject = (reason: string) => (cleanup(), reject(new Error(`rejected: ${reason}`)));
			const onLost = () => (cleanup(), reject(new Error("lost: broker unreachable")));
			const onSuperseded = () => (cleanup(), reject(new Error("superseded")));
			this.once("welcome", onWelcome);
			this.once("rejected", onReject);
			this.once("lost", onLost);
			this.once("superseded", onSuperseded);
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
			this.heard = this.checked = Date.now();
			this.owed.clear();
			this.ask("hello", { t: "hello", proto: PROTO, ...id });
			clearInterval(this.watchdog);
			this.watchdog = setInterval(() => this.overdue(Date.now()) && s.destroy(), WATCHDOG_MS);
			this.watchdog.unref();
		});
		s.on("data", (d: string) => this.onData(d));
		s.on("error", () => {});
		s.on("close", () => {
			if (this.sock === s) this.sock = undefined;
			const was = this.connected;
			this.connected = false;
			clearInterval(this.hb);
			clearInterval(this.watchdog);
			this.owed.clear();
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
				if (!this.redial) return this.dial();
				this.redial().then(
					() => this.dial(),
					(err) => {
						// The tree is over: no point retrying for the whole grace period.
						if (/finished/.test(String(err))) {
							this.shut("tree finished");
							this.emit("rejected", "down");
						} else this.dial();
					},
				);
			}, delay).unref();
		});
	}

	/** The broker owes an answer: silence, or any request unanswered, past the heartbeat timeout. */
	private overdue(now: number): boolean {
		const late = now - this.checked > LATE_MS;
		this.checked = now;
		if (late) {
			// Restart the clocks: the broker's answers may be waiting unread in the socket.
			this.heard = now;
			for (const key of this.owed.keys()) this.owed.set(key, now);
			return false;
		}
		if (now - this.heard >= TIMING.heartbeatTimeoutMs) return true;
		for (const at of this.owed.values()) if (now - at >= TIMING.heartbeatTimeoutMs) return true;
		return false;
	}

	private onData(d: string) {
		this.heard = Date.now();
		const { frames, rest } = decode(this.buf + d);
		this.buf = rest;
		for (const f of frames as Record<string, any>[]) {
			switch (f.t) {
				case "welcome":
					this.connected = true;
					this.lostSince = undefined;
					this.counter = 0;
					this.owed.delete("hello");
					this.realign(f.lastSeq);
					for (const op of this.inflight) this.ask(`op:${op.seq}`, op); // retransmit in order
					this.write({ t: "run", running: this.running }); // the broker keeps it per connection
					clearInterval(this.hb);
					this.hb = setInterval(() => this.write({ t: "hb", usage: this.usage() }), TIMING.heartbeatMs);
					this.hb.unref();
					this.emit("welcome", f);
					break;
				case "resp": {
					this.owed.delete(`op:${f.seq}`);
					const gap = f.response?.error === "seq_gap" && /^expected (\d+)$/.exec(String(f.response.detail ?? ""));
					if (gap) {
						// Not applied: keep it in flight and resend once the broker can take it (issue: seq_gap wedge).
						if (!this.inflight.some((x) => x.seq === f.seq)) break;
						this.gapped.add(f.seq);
						// The seq the broker waits for is no longer ours to send: reconnect, and the
						// welcome renumbers. Otherwise it is still in flight: resend after its answer.
						const want = Number(gap[1]);
						if (want >= f.seq || !this.inflight.some((x) => x.seq === want)) this.sock?.destroy();
						break;
					}
					this.inflight = this.inflight.filter((x) => x.seq !== f.seq);
					const w = this.waiters.get(f.seq);
					this.waiters.delete(f.seq);
					w?.(f.response);
					this.resync();
					break;
				}
				case "fetched": {
					this.owed.delete(`fetch:${f.fetchId}`);
					const r = this.fetches.get(f.fetchId);
					this.fetches.delete(f.fetchId);
					r?.(f.message ?? null);
					break;
				}
				case "inspect": {
					this.owed.delete(`inspect:${f.reqId}`);
					const r = this.inspects.get(f.reqId);
					this.inspects.delete(f.reqId);
					r?.(f.state);
					break;
				}
				case "mail":
					this.emit("mail", !!f.urgent);
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

	/**
	 * After a welcome: frames up to `lastSeq` were applied (their resends get the cached answer);
	 * the rest were not, so they are numbered on from `lastSeq + 1`, in order. Nothing is applied
	 * twice (applied seqs keep their number) and nothing is skipped.
	 */
	private realign(lastSeq: number) {
		this.gapped.clear();
		let next = lastSeq + 1;
		for (const op of this.inflight) {
			if (op.seq <= lastSeq) continue;
			if (op.seq !== next) {
				const w = this.waiters.get(op.seq);
				this.waiters.delete(op.seq);
				op.seq = next;
				if (w) this.waiters.set(op.seq, w);
			}
			next++;
		}
		this.nextSeq = next;
	}

	/**
	 * Once every frame before the held (seq_gap) ones is answered, resend them in order. If one
	 * gaps again for a seq no longer in flight, the client reconnects (see "resp"), so this never loops.
	 */
	private resync() {
		const head = this.inflight[0];
		if (!head || !this.gapped.has(head.seq) || !this.connected) return;
		for (const op of this.inflight) {
			if (!this.gapped.delete(op.seq)) break;
			this.ask(`op:${op.seq}`, op);
		}
	}

	private write(frame: object) {
		if (this.sock && !this.sock.destroyed) this.sock.write(encode(frame));
	}

	/** A request the broker owes an answer to on this connection. */
	private ask(key: string, frame: object) {
		this.owed.set(key, Date.now());
		this.write(frame);
	}

	/** A sequenced operation (spawn, send, exit, kill, forget); idempotent across reconnects. */
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
		if (this.connected) this.ask(`op:${frame.seq}`, frame);
		return p;
	}

	/** Lease the next matching message (null if none, or if the connection drops meanwhile). */
	fetch(filter: FetchFilter = {}): Promise<Message | null> {
		if (!this.connected) return Promise.resolve(null);
		const fetchId = `f${++this.counter}-${Date.now()}`;
		const p = new Promise<Message | null>((resolve) => this.fetches.set(fetchId, resolve));
		this.ask(`fetch:${fetchId}`, { t: "fetch", fetchId, ...filter });
		return p;
	}

	ack(msgId: string) {
		this.write({ t: "ack", msgId });
	}

	release(msgId: string) {
		this.write({ t: "release", msgId });
	}

	inspect(): Promise<Snapshot | undefined> {
		if (!this.connected) return Promise.resolve(undefined);
		const reqId = `i${++this.counter}`;
		const p = new Promise<Snapshot>((resolve) => this.inspects.set(reqId, resolve));
		this.ask(`inspect:${reqId}`, { t: "inspect", reqId });
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

	/** Whether the agent is executing a run; restated on every reconnect. */
	setRunning(running: boolean) {
		this.running = running;
		if (this.connected) this.write({ t: "run", running });
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
