// EventLog: append-only NDJSON of Tree events (design D2, D13), fsynced except UNSYNCED_EVENTS.
// Line 1 is a header; an optional snapshot line follows a compaction. A machine crash can leave
// a torn or holed tail, but only after the last fsync, so only in lines nobody was promised:
// open cuts the file back to the last good line before appending again.

import { closeSync, existsSync, fstatSync, fsyncSync, openSync, readFileSync, renameSync, truncateSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
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

	private constructor(path: string, fd: number) {
		this.path = path;
		this.fd = fd;
	}

	/** Open (creating with a header if missing) and return the log plus everything in it. */
	static open(dir: string, treeId: string): { log: EventLog; loaded: Loaded } {
		const path = join(dir, "events.log");
		const loaded = existsSync(path) ? EventLog.read(path, treeId) : undefined;
		if (!loaded) writeAtomic(path, `${JSON.stringify({ pia_log: LOG_VERSION, treeId } satisfies Header)}\n`);
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
		writeSync(this.fd, `${JSON.stringify({ ev, t })}\n`);
		if (durable) fsyncSync(this.fd);
	}

	get size(): number {
		return fstatSync(this.fd).size;
	}

	needsCompaction(): boolean {
		return this.size > COMPACT_BYTES;
	}

	/** Replace the log with header + snapshot (atomic rename), then keep appending to it. */
	compact(state: TreeState, t: number): void {
		const header: Header = { pia_log: LOG_VERSION, treeId: state.treeId };
		writeAtomic(this.path, `${JSON.stringify(header)}\n${JSON.stringify({ snapshot: state, t })}\n`);
		closeSync(this.fd);
		this.fd = openSync(this.path, "a");
	}

	close(): void {
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

function writeAtomic(path: string, content: string) {
	const tmp = `${path}.tmp-${process.pid}`;
	const fd = openSync(tmp, "w");
	writeSync(fd, content);
	fsyncSync(fd);
	closeSync(fd);
	renameSync(tmp, path);
	// The rename itself must reach the disk, or a machine crash can bring back the old file.
	const dirFd = openSync(dirname(path), "r");
	try {
		fsyncSync(dirFd);
	} finally {
		closeSync(dirFd);
	}
}
