import assert from "node:assert/strict";
import { test } from "node:test";
import { ENTRY_TYPE, type Fetcher, formatDelivery, Mailroom } from "../src/client/mailroom.ts";
import type { Message } from "../src/protocol.ts";

function fetcher(queue: Message[]): Fetcher & { acked: string[] } {
	const acked: string[] = [];
	return {
		acked,
		fetch: async () => queue.shift() ?? null,
		ack: (id) => void acked.push(id),
	};
}
const msg = (id: string, extra: Partial<Message> = {}): Message => ({ id, from: "root", to: "a", kind: "mail", body: `body ${id}`, ...extra });
const entry = (ids: string[], self = "a") => ({ type: "custom_message", customType: ENTRY_TYPE, details: { actors: { id: self, consumed: ids } } });

test("drain collects a batch; settle acks only what is persisted", async () => {
	const room = new Mailroom("a");
	const f = fetcher([msg("m1"), msg("m2")]);
	const batch = await room.drain(f);
	assert.deepEqual(batch.map((m) => m.id), ["m1", "m2"]);
	assert.deepEqual(f.acked, [], "nothing acked before the entry is persisted");
	room.settle([entry(["m1", "m2"])], f);
	assert.deepEqual(f.acked, ["m1", "m2"]);
	room.settle([entry(["m1", "m2"])], f);
	assert.deepEqual(f.acked, ["m1", "m2"], "acked once");
});

test("already-consumed messages (restored from the session) are acked and dropped", async () => {
	const room = new Mailroom("a");
	room.restore([entry(["m1"]), entry(["x"], "someone-else")]);
	const f = fetcher([msg("m1"), msg("x"), msg("m2")]);
	const batch = await room.drain(f);
	assert.deepEqual(batch.map((m) => m.id), ["x", "m2"], "a forked parent's stamp does not count as ours");
	assert.deepEqual(f.acked, ["m1"]);
});

test("a message still being delivered is not delivered twice (lease returned after a reconnect)", async () => {
	const room = new Mailroom("a");
	await room.drain(fetcher([msg("m1")]));
	const again = await room.drain(fetcher([msg("m1")]));
	assert.deepEqual(again, []);
	room.forgetInFlight(); // a reload lost the injected entry: redeliver
	assert.deepEqual((await room.drain(fetcher([msg("m1")]))).map((m) => m.id), ["m1"]);
});

test("formatting labels senders, reports, answers and ends; never as user input", () => {
	const text = formatDelivery("root", [
		msg("t", { tag: "task" }),
		msg("r", { from: "kid", tag: "report", body: "done" }),
		msg("h", { from: "human", kind: "reply", ref: "root:1:3", body: "yes" }),
		msg("d", { from: "broker", kind: "down", body: JSON.stringify({ id: "kid", reason: "killed" }) }),
	]);
	assert.match(text, /^\[pi-actors\] 4 updates for root/);
	assert.match(text, /Report from kid/);
	assert.match(text, /The human answered your message root:1:3/);
	assert.match(text, /kid has ended: killed/);
	assert.match(formatDelivery("a", [msg("big", { body: "x".repeat(20_000) })]), /truncated/);
});

test("F4: reclaim returns only injections that are old enough and never reached the session", async () => {
	const room = new Mailroom("a");
	await room.drain(fetcher([msg("old"), msg("saved")]));
	const later = Date.now() + 6000;
	assert.deepEqual(room.reclaim([entry(["saved"])], 5000, Date.now()), [], "too young to call lost");
	assert.deepEqual(room.reclaim([entry(["saved"])], 5000, later), ["old"]);
	assert.deepEqual((await room.drain(fetcher([msg("old")]))).map((m) => m.id), ["old"], "redelivered");
});

test("F9: a drain requested while one runs is not dropped: the running drain fetches again", async () => {
	const room = new Mailroom("a");
	const queue = [msg("m1")];
	let notified = false;
	const f: Fetcher = {
		fetch: async () => {
			const m = queue.shift() ?? null;
			if (!m && !notified) {
				// The worst moment: the running drain just found the mailbox empty when new mail
				// arrives and its notice asks for another drain.
				notified = true;
				queue.push(msg("m2"));
				void room.drain(f);
			}
			return m;
		},
		ack() {},
	};
	assert.deepEqual((await room.drain(f)).map((m) => m.id), ["m1", "m2"]);
});
