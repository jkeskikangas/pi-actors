import assert from "node:assert/strict";
import { test } from "node:test";
import { dedupeContext, ENTRY_TYPE, type Fetcher, formatDelivery, Mailroom } from "../src/client/mailroom.ts";
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

test("N1: the model sees each message once, even when pi kept an injection that was also redelivered", () => {
	const delivered = (self: string, ms: Message[]) => ({ role: "custom", customType: ENTRY_TYPE, content: formatDelivery(self, ms), details: { actors: { id: self, consumed: ms.map((m) => m.id), messages: ms } } });
	const user = { role: "user", content: "hi" };
	const first = delivered("a", [msg("m1"), msg("m2")]);
	const other = delivered("b", [msg("m1")]); // a forked parent's entry: not ours, left alone
	assert.equal(dedupeContext("a", [user, first, other]), undefined, "nothing to change");
	const out = dedupeContext("a", [user, first, other, delivered("a", [msg("m1")]), delivered("a", [msg("m2"), msg("m3")])]) as any[];
	assert.equal(out.length, 4, "the full duplicate is gone");
	assert.deepEqual(out.at(-1).details.actors.consumed, ["m3"], "a partial duplicate keeps only the new message");
	assert.match(out.at(-1).content, /body m3/);
	assert.doesNotMatch(out.at(-1).content, /body m2/);
});

test("stamps keep at most what the delivery shows, and a rebuilt entry still says it was truncated", () => {
	const room = new Mailroom("a");
	const stamp = room.stamp([msg("big", { body: "x".repeat(200_000) }), msg("d", { kind: "down", body: JSON.stringify({ id: "kid", reason: "normal", result: "r".repeat(30_000) }) })]);
	assert.ok(stamp.messages![0].body.length <= 16 * 1024 + 1, "no 200 kB body in the session entry");
	assert.match(formatDelivery("a", stamp.messages!), /truncated/);
	assert.match(formatDelivery("a", stamp.messages!), /kid has ended: normal/, "an end notice still parses");
});

test("an end notice's result is shown without terminal control sequences", () => {
	const text = formatDelivery("root", [msg("d", { from: "broker", kind: "down", body: JSON.stringify({ id: "kid", reason: "normal", result: "ok\u001b[2J\u0007done" }) })]);
	assert.doesNotMatch(text, /[\u001b\u0007]/);
	assert.match(text, /ok\[2Jdone/);
});

test("a stamp cut by the shown (cleaned) length keeps the truncated note when rebuilt", () => {
	const room = new Mailroom("a");
	const m = msg("ctl", { body: "\u0007".repeat(100) + "x".repeat(16 * 1024 + 50) });
	assert.match(formatDelivery("a", [m]), /truncated/);
	assert.match(formatDelivery("a", room.stamp([m]).messages), /truncated/);
});

test("the context hook passes over a stamp without its messages instead of failing", () => {
	const bare = (ids: string[]) => ({ role: "custom", customType: ENTRY_TYPE, content: ids.join(","), details: { actors: { id: "a", consumed: ids } } });
	assert.doesNotThrow(() => dedupeContext("a", [bare(["m1"]), bare(["m1", "m2"])]));
});
