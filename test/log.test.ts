// EventLog crash recovery: what a machine crash can leave at the end of the log.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { EventLog } from "../src/broker/log.ts";
import type { Event } from "../src/tree.ts";

const dir = mkdtempSync("/tmp/pia-log-");
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const send = (seq: number): Event => ({ type: "send", now: 0, from: "root", seq, to: "a", kind: "mail", body: "hi" });
const fetch = (): Event => ({ type: "fetch", id: "a", fetchId: "f1" });

function fresh() {
	const tree = `t${++n}`;
	const d = join(dir, tree);
	rmSync(d, { recursive: true, force: true });
	mkdirSync(d);
	return { d, tree };
}

test("a torn tail is cut off on open, so events appended after it replay", () => {
	const { d, tree } = fresh();
	const { log } = EventLog.open(d, tree);
	log.append(send(1), 1);
	log.close();
	appendFileSync(join(d, "events.log"), '{"ev":{"type":"fetch","id":"a"'); // crash mid-line
	const second = EventLog.open(d, tree);
	assert.equal(second.loaded.events.length, 1);
	second.log.append(send(2), 2);
	second.log.close();
	assert.deepEqual(EventLog.open(d, tree).loaded.events.map((e) => (e as { seq?: number }).seq), [1, 2]);
});

test("an unsynced tail with a hole (unwritten page reads as zeros) is dropped, not fatal", () => {
	const { d, tree } = fresh();
	const { log } = EventLog.open(d, tree);
	log.append(send(1), 1);
	log.close();
	appendFileSync(join(d, "events.log"), `${"\0".repeat(40)}\n${JSON.stringify({ ev: fetch(), t: 2 })}\n`);
	assert.equal(EventLog.open(d, tree).loaded.events.length, 1);
	assert.ok(readFileSync(join(d, "events.log"), "utf8").endsWith(`${JSON.stringify({ ev: send(1), t: 1 })}\n`), "the file is cut back to the good prefix");
});

test("a bad line followed by a durable event is real corruption", () => {
	const { d, tree } = fresh();
	const { log } = EventLog.open(d, tree);
	log.append(send(1), 1);
	log.close();
	appendFileSync(join(d, "events.log"), `garbage\n${JSON.stringify({ ev: send(2), t: 2 })}\n`);
	assert.throws(() => EventLog.open(d, tree), /corrupt event log/);
});
