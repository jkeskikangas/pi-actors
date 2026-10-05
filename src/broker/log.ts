// EventLog: append-only, fsynced NDJSON of Tree events (design D2, D13).
// Line 1 is a header; an optional snapshot line follows a compaction. A torn last line (crash
// mid-append) is dropped on replay: it was never acknowledged, so its sender retransmits.

import { closeSync, existsSync, fstatSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Event, TreeState } from "../tree.ts";

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
		const loaded = existsSync(path) ? EventLog.read(path, treeId) : { snapshot: undefined, events: [], lastTime: undefined };
		if (!existsSync(path)) writeAtomic(path, `${JSON.stringify({ pia_log: LOG_VERSION, treeId } satisfies Header)}\n`);
		return { log: new EventLog(path, openSync(path, "a")), loaded };
	}

	static read(path: string, treeId: string): Loaded {
		const lines = readFileSync(path, "utf8").split("\n");
		const header = JSON.parse(lines[0] ?? "{}") as Partial<Header>;
		if (header.pia_log !== LOG_VERSION) throw new Error(`unsupported event log version ${header.pia_log} in ${path}`);
		if (header.treeId !== treeId) throw new Error(`event log ${path} belongs to tree ${header.treeId}`);
		let snapshot: TreeState | undefined;
		const events: Event[] = [];
		let lastTime: number | undefined;
		for (let i = 1; i < lines.length; i++) {
			const line = lines[i];
			if (!line) continue;
			let rec: { snapshot?: TreeState; ev?: Event; t?: number };
			try {
				rec = JSON.parse(line);
			} catch {
				if (i >= lines.length - 2) break; // torn final line
				throw new Error(`corrupt event log ${path} at line ${i + 1}`);
			}
			if (rec.snapshot) {
				snapshot = rec.snapshot;
				events.length = 0;
			} else if (rec.ev) events.push(rec.ev);
			if (rec.t !== undefined) lastTime = rec.t;
		}
		return { snapshot, events, lastTime };
	}

	/** Durably append one event; returns only after fsync. */
	append(ev: Event, t: number): void {
		writeSync(this.fd, `${JSON.stringify({ ev, t })}\n`);
		fsyncSync(this.fd);
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

function writeAtomic(path: string, content: string) {
	const tmp = `${path}.tmp-${process.pid}`;
	const fd = openSync(tmp, "w");
	writeSync(fd, content);
	fsyncSync(fd);
	closeSync(fd);
	renameSync(tmp, path);
}
