// EventLog: append-only NDJSON of Tree events (design D2, D13), fsynced except UNSYNCED_EVENTS.
// Line 1 is a header; an optional snapshot line follows a compaction. A machine crash can leave
// a torn or holed tail, but only after the last fsync, so only in lines nobody was promised:
// open cuts the file back to the last good line before appending again.

import { closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, openSync, readFileSync, truncateSync, writeSync } from "node:fs";
import { join } from "node:path";
import { injectedFault, writeFileAtomicSync } from "../runtime.ts";
import { type Event, type TreeState, UNSYNCED_EVENTS } from "../tree.ts";

export const LOG_VERSION = 1;
const COMPACT_BYTES = 8 * 1024 * 1024;

interface Header {
	pia_log: number;
	treeId: string;
}

export interface Loaded {
	snapshot: TreeState | undefined;
	events: Event[];
	/** Wall-clock time of the last logged event (for downtime on recovery). */
	lastTime: number | undefined;
	/** Bytes of the file up to the end of the last good line. */
	goodBytes: number;
}

export class EventLog {
	private fd: number;
	readonly path: string;
	/** Bytes of whole lines in the file: a failed append is cut back to this. */
	private bytes: number;
	/** Lines a failing disk refused, in order; written before anything newer. */
	private held: string[] = [];
	private torn = false;
	private unsynced = false;
	private error: string | undefined;
	/** Told once when writing starts failing and once when it works again. */
	report: (msg: string) => void = (msg) => console.error(`${new Date().toISOString()} ${msg}`);

	private constructor(path: string, fd: number) {
		this.path = path;
		this.fd = fd;
		this.bytes = fstatSync(fd).size;
	}

	/** Open (creating with a header if missing) and return the log plus everything in it. */
	static open(dir: string, treeId: string): { log: EventLog; loaded: Loaded } {
		const path = join(dir, "events.log");
		const loaded = existsSync(path) ? EventLog.read(path, treeId) : undefined;
		if (!loaded) writeFileAtomicSync(path, `${JSON.stringify({ pia_log: LOG_VERSION, treeId } satisfies Header)}\n`);
		else if (loaded.goodBytes < fstatSize(path)) truncateSync(path, loaded.goodBytes);
		return { log: new EventLog(path, openSync(path, "a")), loaded: loaded ?? { snapshot: undefined, events: [], lastTime: undefined, goodBytes: 0 } };
	}

	static read(path: string, treeId: string): Loaded {
		const lines = readFileSync(path, "utf8").split("\n");
		const header = JSON.parse(lines[0] ?? "{}") as Partial<Header>;
		if (header.pia_log !== LOG_VERSION) throw new Error(`unsupported event log version ${header.pia_log} in ${path}`);
		if (header.treeId !== treeId) throw new Error(`event log ${path} belongs to tree ${header.treeId}`);
		let snapshot: TreeState | undefined;
		const events: Event[] = [];
		let lastTime: number | undefined;
		let goodBytes = Buffer.byteLength(lines[0]) + 1;
		// The last element has no newline: empty, or a line torn mid-append. Either way not ours.
		const complete = lines.slice(0, -1);
		for (let i = 1; i < complete.length; i++) {
			const line = complete[i];
			const rec = parseLine(line);
			if (!rec) {
				// The unsynced tail: only bad lines and unsynced events may follow. A durable event
				// after a bad line means its fsync covered the bad line too: real corruption.
				if (complete.slice(i + 1).every((l) => !parseLine(l)?.ev || UNSYNCED_EVENTS.has(parseLine(l)!.ev!.type))) break;
				throw new Error(`corrupt event log ${path} at line ${i + 1}`);
			}
			goodBytes += Buffer.byteLength(line) + 1;
			if (!line) continue;
			if (rec.snapshot) {
				snapshot = rec.snapshot;
				events.length = 0;
			} else if (rec.ev) events.push(rec.ev);
			if (rec.t !== undefined) lastTime = rec.t;
		}
		return { snapshot, events, lastTime, goodBytes };
	}

	/**
	 * Append one event. Written in order either way, so a broker crash loses nothing; `durable`
	 * also waits for the disk (fsync), which covers earlier unsynced events too. On macOS, libuv's
	 * fsync is F_FULLFSYNC (past the drive cache).
	 */
	append(ev: Event, t: number, durable = true): void {
		const line = `${JSON.stringify({ ev, t })}\n`;
		if (this.error) {
			// Never out of order: behind the held lines, and only once they are written.
			this.held.push(line);
			this.unsynced ||= durable;
			this.flush();
			return;
		}
		try {
			this.writeLine(line);
		} catch (err) {
			this.held.push(line);
			this.unsynced ||= durable;
			return this.failed(err);
		}
		if (!durable) return;
		try {
			fsyncSync(this.fd);
		} catch (err) {
			this.unsynced = true;
			this.failed(err);
		}
	}

	/**
	 * A full or failing disk (ENOSPC, EIO) does not stop the broker: refused lines are held in
	 * memory, in order, and written by the next append or `flush` once the disk takes them. Until
	 * then they are not durable: a broker crash in that window loses them.
	 */
	get failing(): string | undefined {
		return this.error;
	}

	/** Retry what the disk refused; true once everything is written and synced. */
	flush(): boolean {
		if (!this.error) return true;
		try {
			if (this.torn) {
				ftruncateSync(this.fd, this.bytes);
				this.torn = false;
			}
			while (this.held.length > 0) {
				this.writeLine(this.held[0]);
				this.held.shift();
			}
			if (this.unsynced) fsyncSync(this.fd);
			this.unsynced = false;
		} catch (err) {
			this.failed(err);
			return false;
		}
		this.report(`event log ${this.path} is writable again`);
		this.error = undefined;
		return true;
	}

	/** One whole line or nothing: a short write (a full disk) is cut back off the file. */
	private writeLine(line: string) {
		const buf = Buffer.from(line);
		let off = 0;
		try {
			while (off < buf.length) {
				injectedFault(this.path, () => (off += writeSync(this.fd, buf, off, Math.ceil((buf.length - off) / 2))));
				off += writeSync(this.fd, buf, off);
			}
		} catch (err) {
			if (off > 0) {
				try {
					ftruncateSync(this.fd, this.bytes);
				} catch {
					this.torn = true; // cut before the next write, or it would follow a torn line
				}
			}
			throw err;
		}
		this.bytes += buf.length;
	}

	private failed(err: unknown) {
		const msg = (err as Error)?.message ?? String(err);
		if (!this.error) this.report(`event log ${this.path}: ${msg}; holding events in memory and retrying`);
		this.error = msg;
	}

	get size(): number {
		return fstatSync(this.fd).size;
	}

	needsCompaction(now = Date.now()): boolean {
		return now >= this.compactRetryAt && this.size > COMPACT_BYTES;
	}

	/** After a failed compaction, the next try waits: each one writes the whole state. */
	private compactRetryAt = 0;

	/**
	 * Replace the log with header + snapshot (atomic rename), then keep appending to it. The
	 * snapshot covers any held lines too. False (old log kept) when the disk refuses it.
	 */
	compact(state: TreeState, t: number): boolean {
		const header: Header = { pia_log: LOG_VERSION, treeId: state.treeId };
		try {
			writeFileAtomicSync(this.path, `${JSON.stringify(header)}\n${JSON.stringify({ snapshot: state, t })}\n`);
		} catch (err) {
			if (this.compactRetryAt === 0) this.report(`event log ${this.path}: compaction failed: ${(err as Error)?.message ?? err}; keeping the uncompacted log`);
			this.compactRetryAt = Date.now() + 60_000;
			return false;
		}
		closeSync(this.fd);
		this.fd = openSync(this.path, "a");
		this.bytes = fstatSync(this.fd).size;
		this.compactRetryAt = 0;
		this.held = [];
		this.torn = this.unsynced = false;
		if (this.error) this.report(`event log ${this.path} is writable again (compacted)`);
		this.error = undefined;
		return true;
	}

	close(): void {
		this.flush();
		closeSync(this.fd);
	}
}

/** A complete record, or undefined for a torn, zero-filled or garbled line. Empty lines are fine. */
function parseLine(line: string): { snapshot?: TreeState; ev?: Event; t?: number } | undefined {
	if (!line) return {};
	try {
		const rec = JSON.parse(line);
		return rec && typeof rec === "object" ? rec : undefined;
	} catch {
		return undefined;
	}
}

function fstatSize(path: string): number {
	const fd = openSync(path, "r");
	try {
		return fstatSync(fd).size;
	} finally {
		closeSync(fd);
	}
}

