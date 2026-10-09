// Scripted Tree scenarios: the Quint `run` tests (model/pi_actors.qnt) plus unit cases for the
// parts the model does not cover (identity, limits, timers, idempotency, forget).

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_LIMITS, TIMING } from "../src/protocol.ts";
import { apply, type Effect, type Event, finished, initial, nextDeadline, recover, replay, ROOT, type SpawnRequest, type TreeState } from "../src/tree.ts";

/** A tiny driver: applies events, remembers the log, and hands out sender seq numbers. */
function driver(limits = DEFAULT_LIMITS) {
	let st = initial("t", limits, 0);
	const log: Event[] = [];
	const seqs: Record<string, number> = {};
	let now = 0;
	const run = (ev: Event): Effect[] => {
		const r = apply(st, ev);
		st = r.state;
		log.push(ev);
		return r.effects;
	};
	const nextSeq = (id: string) => (seqs[id] = (seqs[id] ?? 0) + 1);
	const respond = (fx: Effect[]) => fx.find((e) => e.type === "respond") as Extract<Effect, { type: "respond" }>;
	const d = {
		get st() { return st; },
		log,
		run,
		advance: (ms: number) => (now += ms),
		hello: (id: string, pid = 100, extra: Partial<Extract<Event, { type: "hello" }>> = {}) =>
			run({ type: "hello", now, id, inc: st.agents[id]?.inc ?? 1, pid, sessionId: `s-${id}`, ownsPid: true, ...extra }),
		spawn: (from: string, req: Partial<SpawnRequest> = {}) => {
			const fx = run({ type: "spawn", now, from, seq: nextSeq(from), req: { task: "do it", context: "fresh", placement: "headless", ...req } });
			return respond(fx).response;
		},
		start: (id: string, pid: number) => {
			run({ type: "procStart", id, inc: st.agents[id].inc, pid });
			return d.hello(id, pid);
		},
		send: (from: string, to: string, body = "hi", extra: Partial<Extract<Event, { type: "send" }>> = {}) =>
			respond(run({ type: "send", now, from, seq: nextSeq(from), to, kind: "mail", body, ...extra })).response,
		fetch: (id: string, filter: Partial<Extract<Event, { type: "fetch" }>> = {}) =>
			(run({ type: "fetch", id, fetchId: `f${log.length}`, ...filter }).find((e) => e.type === "fetched") as Extract<Effect, { type: "fetched" }>).message,
		ack: (id: string, msgId: string) => run({ type: "ack", id, msgId }),
		tick: () => run({ type: "tick", now }),
		nextSeq,
		respond,
	};
	return d;
}

/** Root connected, child "a" spawned and connected. */
function withChild() {
	const d = driver();
	d.hello(ROOT, 1);
	const r = d.spawn(ROOT, { name: "a" });
	assert.equal(r.ok, true);
	d.start("a", 200);
	return d;
}

const downs = (st: TreeState, id: string) => (st.mailbox[st.agents[id].parent!] ?? []).filter((m) => m.kind === "down" && JSON.parse(m.body).id === id);

// ---- the Quint scenarios ------------------------------------------------------------

test("redelivery after reload: unacked message comes back, lease released on disconnect", () => {
	const d = withChild();
	d.send(ROOT, "a");
	const task = d.fetch("a")!; // the spawn task is the first mail
	d.ack("a", task.id);
	const m = d.fetch("a")!;
	assert.equal(m.body, "hi");
	assert.equal(d.fetch("a"), null, "leased: a parallel fetch does not get it again");
	d.run({ type: "disconnect", now: 0, id: "a", conn: d.st.agents.a.conn });
	d.hello("a", 200);
	assert.equal(d.fetch("a")?.id, m.id, "redelivered after reconnect");
});

test("retransmit after broker crash is deduplicated by sender seq", () => {
	const d = withChild();
	const seq = d.nextSeq(ROOT);
	const send: Event = { type: "send", now: 0, from: ROOT, seq, to: "a", kind: "mail", body: "once" };
	d.run(send);
	const restarted = recover(replay(initial("t", DEFAULT_LIMITS, 0), d.log), 0);
	const r = apply(restarted, send);
	assert.deepEqual(d.respond(r.effects).response.ok, true);
	assert.equal(r.state.mailbox.a.filter((m) => m.body === "once").length, 1);
});

test("link: a crashed parent's child is killed, and DOWN reaches the grandparent once", () => {
	const d = withChild();
	assert.equal(d.spawn("a", { name: "c" }).ok, true);
	d.start("a.c", 300);
	d.run({ type: "procExit", now: 0, id: "a", inc: 1, code: 1, signal: null });
	assert.equal(d.st.agents.a.status, "down");
	assert.match(d.st.agents.a.reason!, /crashed/);
	assert.equal(d.st.agents["a.c"].status, "killing");
	d.run({ type: "procExit", now: 0, id: "a.c", inc: 1, code: null, signal: "SIGTERM" });
	assert.equal(d.st.agents["a.c"].reason, "killed:parent_down");
	assert.equal(downs(d.st, "a").length, 1);
});

test("replay + recover: live agents become disconnected; orphans are swept", () => {
	const d = withChild();
	const st = recover(replay(initial("t", DEFAULT_LIMITS, 0), d.log), 0);
	assert.equal(st.agents.a.status, "disconnected");
	assert.equal(st.agents[ROOT].status, "disconnected");
	const orphan = structuredClone(st);
	orphan.agents[ROOT].status = "down";
	assert.equal(recover(orphan, 0).agents.a.status, "killing");
});

test("send after reload continues from welcome.last_seq", () => {
	const d = withChild();
	d.send(ROOT, "a", "one");
	const welcome = d.hello(ROOT, 1).find((e) => e.type === "welcome") as Extract<Effect, { type: "welcome" }>;
	assert.equal(welcome.lastSeq, 2, "spawn + send");
	const r = d.respond(d.run({ type: "send", now: 0, from: ROOT, seq: welcome.lastSeq + 1, to: "a", kind: "mail", body: "two" })).response;
	assert.equal(r.ok, true);
	assert.deepEqual(d.st.mailbox.a.map((m) => m.body), ["do it", "one", "two"]);
});

// ---- identity -------------------------------------------------------------------------

test("identity: hello is held until the Keeper reports the process, then pid must match", () => {
	const d = driver();
	d.hello(ROOT, 1);
	d.spawn(ROOT, { name: "a" });
	assert.equal(d.hello("a", 200)[0].type, "hold");
	d.run({ type: "procStart", id: "a", inc: 1, pid: 200 });
	assert.deepEqual(d.hello("a", 999, { ownsPid: false })[0], { type: "reject", to: "a", reason: "pid_mismatch" });
	assert.equal(d.hello("a", 200).at(-1)?.type, "welcome");
	const again = d.hello("a", 200);
	assert.equal(again[0].type, "superseded", "a reload in the same pid supersedes the old connection");
});

test("identity: the root is fenced by pid and session id", () => {
	const d = driver();
	d.hello(ROOT, 1, { sessionId: "S" });
	assert.equal(d.hello(ROOT, 2, { sessionId: "FORK" })[0].type, "reject", "a forked root session is rejected");
	assert.equal(d.hello(ROOT, 2, { sessionId: "S", recordedPidAlive: true })[0].type, "reject", "old root still alive");
	assert.equal(d.hello(ROOT, 2, { sessionId: "S", recordedPidAlive: false }).at(-1)?.type, "welcome", "--continue after a crash");
});

test("N4: a root that switched sessions (/new) can be continued from the new session after a crash", () => {
	const d = driver();
	d.hello(ROOT, 1, { sessionId: "S" });
	assert.equal(d.hello(ROOT, 1, { sessionId: "NEW" }).at(-1)?.type, "welcome", "same process, new session");
	assert.equal(d.hello(ROOT, 2, { sessionId: "S", recordedPidAlive: false })[0].type, "reject", "the old session no longer owns the root");
	assert.equal(d.hello(ROOT, 2, { sessionId: "NEW", recordedPidAlive: false }).at(-1)?.type, "welcome", "pi --continue of the new session");
});

test("identity: a down agent and a stale incarnation are rejected", () => {
	const d = withChild();
	d.run({ type: "procExit", now: 0, id: "a", inc: 1, code: 0, signal: null });
	assert.deepEqual(d.hello("a", 200)[0], { type: "reject", to: "a", reason: "down" });
});

// ---- mail and reply_to ---------------------------------------------------------------

test("send: only mail; reply_to travels as the message's ref; nothing reaches an ended agent", () => {
	const d = withChild();
	assert.deepEqual(d.respond(d.run({ type: "send", now: 0, from: "a", seq: d.nextSeq("a"), to: ROOT, kind: "call" as never, body: "q?" })).response, { ok: false, error: "bad_request", detail: "only mail can be sent" });
	assert.deepEqual(d.send("a", "human"), { ok: false, error: "unknown_target", detail: undefined }, "there is no human route");
	const q = d.send("a", ROOT, "REST or GraphQL?") as { msgId: string };
	assert.equal(d.send(ROOT, "a", "REST", { ref: q.msgId }).ok, true);
	assert.equal(d.fetch("a")?.tag, "task");
	assert.equal(d.fetch("a")?.ref, q.msgId);
	d.run({ type: "procExit", now: 0, id: "a", inc: 1, code: 0, signal: null });
	assert.equal(d.send(ROOT, "a").ok, false);
});

// ---- forget ---------------------------------------------------------------------------

const forget = (d: ReturnType<typeof driver>, from: string, target: string) => d.respond(d.run({ type: "forget", now: 0, from, seq: d.nextSeq(from), target })).response;

test("forget: only a whole ended subtree, only by an ancestor; it leaves no trace but the retired id", () => {
	const d = withChild();
	d.spawn("a", { name: "k" });
	d.start("a.k", 300);
	d.spawn(ROOT, { name: "b" });
	d.start("b", 201);
	assert.deepEqual(forget(d, ROOT, "a"), { ok: false, error: "bad_request", detail: "still running" });
	d.run({ type: "procExit", now: 0, id: "a", inc: 1, code: 0, signal: null }); // a.k is killed with it
	assert.deepEqual(forget(d, ROOT, "a"), { ok: false, error: "bad_request", detail: "still running" }, "a.k is still being stopped");
	d.run({ type: "procExit", now: 0, id: "a.k", inc: 1, code: null, signal: "SIGTERM" });
	assert.deepEqual(forget(d, "b", "a"), { ok: false, error: "not_authorized", detail: undefined }, "a sibling may not");
	assert.deepEqual(forget(d, ROOT, "a"), { ok: true, type: "done" });
	for (const id of ["a", "a.k"]) {
		assert.equal(d.st.agents[id], undefined);
		assert.equal(d.st.mailbox[id], undefined);
		assert.equal(Object.keys(d.st.seq).some((k) => k.startsWith(`${id}:`)), false);
	}
	assert.deepEqual(forget(d, ROOT, "a"), { ok: false, error: "unknown_target", detail: undefined });
	assert.deepEqual(d.hello("a", 200)[0], { type: "reject", to: "a", reason: "unknown" }, "a lingering process cannot come back");
	assert.equal((d.spawn(ROOT, { name: "a" }) as { id: string }).id, "a-2", "a retired id is never reused");
	assert.equal(finished(d.st), false);
});

test("forget: an ended child of a running parent is that parent's to clear (it may resume it)", () => {
	const d = withChild();
	d.spawn("a", { name: "k" });
	d.start("a.k", 300);
	d.run({ type: "procExit", now: 0, id: "a.k", inc: 1, code: 0, signal: null });
	assert.deepEqual(forget(d, ROOT, "a.k"), { ok: false, error: "bad_request", detail: "its parent still runs" });
	assert.deepEqual(forget(d, "a", "a.k"), { ok: true, type: "done" });
});

test("forget is replayable and survives a snapshot written before it existed", () => {
	const d = withChild();
	d.run({ type: "procExit", now: 0, id: "a", inc: 1, code: 0, signal: null });
	forget(d, ROOT, "a");
	assert.deepEqual(replay(initial("t", DEFAULT_LIMITS, 0), d.log), d.st);
	const old = structuredClone(d.st) as Partial<TreeState>;
	delete old.forgotten;
	assert.equal(apply(old as TreeState, { type: "tick", now: 0 }).state.forgotten.length, 0);
});

// ---- limits, mailbox ------------------------------------------------------------------

test("limits: depth and the spawn count apply at every ancestor; a subtree can only tighten them", () => {
	const d = driver({ maxDepth: 2, maxSpawns: 3 });
	d.hello(ROOT, 1);
	d.spawn(ROOT, { name: "a", limits: { maxSpawns: 1, maxDepth: 5 } });
	d.start("a", 200);
	assert.equal(d.st.agents.a.limits.maxDepth, 2, "cannot loosen depth");
	assert.equal(d.spawn("a", { name: "c" }).ok, true);
	d.start("a.c", 300);
	assert.deepEqual(d.spawn("a.c", { name: "x" }), { ok: false, error: "limit_depth", detail: undefined });
	assert.deepEqual(d.spawn("a", { name: "d" }), { ok: false, error: "budget_exhausted", detail: undefined }, "a's own cap of 1");
	assert.equal(d.spawn(ROOT, { name: "b" }).ok, true);
	assert.deepEqual(d.spawn(ROOT, { name: "e" }), { ok: false, error: "budget_exhausted", detail: undefined }, "tree cap of 3");
});

test("mailbox: ordinary mail is bounded; DOWN is exempt", () => {
	const d = withChild();
	let r;
	for (let i = 0; i < 300 && (r = d.send(ROOT, "a", `m${i}`)).ok; i++);
	assert.deepEqual(r, { ok: false, error: "mailbox_full", detail: undefined });
	assert.equal(d.st.mailbox.a.length, 200);
	d.run({ type: "procExit", now: 0, id: "a", inc: 1, code: 0, signal: null });
	assert.equal(downs(d.st, "a").length, 1);
});

// ---- lifecycle, timers ----------------------------------------------------------------

test("exit then process exit gives DOWN normal with the result; kill during exiting is ignored", () => {
	const d = withChild();
	const fx = d.run({ type: "exit", now: 0, from: "a", seq: d.nextSeq("a"), result: "done!", truncated: false });
	assert.ok(fx.some((e) => e.type === "terminate"));
	assert.equal(d.respond(d.run({ type: "kill", now: 0, from: ROOT, seq: d.nextSeq(ROOT), target: "a" })).response.ok, true);
	assert.equal(d.st.agents.a.status, "exiting");
	d.run({ type: "procExit", now: 0, id: "a", inc: 1, code: 143, signal: null });
	const down = JSON.parse(downs(d.st, "a")[0].body);
	assert.deepEqual([down.reason, down.result], ["normal", "done!"]);
});

test("kill escalation: TERM at +5 s, KILL at +10 s, unconfirmed DOWN at +15 s", () => {
	const d = withChild();
	d.run({ type: "kill", now: 0, from: ROOT, seq: d.nextSeq(ROOT), target: "a" });
	const sigs: string[] = [];
	for (const t of [5000, 5000, 5000]) {
		d.advance(t);
		for (const e of d.tick()) if (e.type === "signal") sigs.push(e.sig);
	}
	assert.deepEqual(sigs, ["TERM", "KILL", "KILL"]);
	assert.equal(d.st.agents.a.reason, "killed:unconfirmed");
	assert.equal(downs(d.st, "a").length, 1);
});

test("grace: a disconnected child is lost after G; a sleep shifts the deadline instead of expiring it", () => {
	const d = withChild();
	d.run({ type: "disconnect", now: 0, id: "a", conn: d.st.agents.a.conn });
	d.run({ type: "slept", ms: 3_600_000 });
	d.advance(TIMING.childGraceMs + 1);
	d.tick();
	assert.equal(d.st.agents.a.status, "disconnected", "the hour of sleep does not count");
	d.advance(3_600_000);
	d.tick();
	assert.equal(d.st.agents.a.status, "killing");
	assert.equal(d.st.agents.a.pendingReason, "lost");
});

test("start timeout and run timeout", () => {
	const d = driver();
	d.hello(ROOT, 1);
	d.spawn(ROOT, { name: "slow" });
	d.advance(TIMING.startMs);
	d.tick();
	assert.equal(d.st.agents.slow.pendingReason, "error:start_timeout");
	const d2 = withChild();
	d2.spawn(ROOT, { name: "t", timeoutS: 1 });
	d2.start("t", 300);
	d2.advance(1000);
	d2.tick();
	assert.equal(d2.st.agents.t.pendingReason, "timeout");
});

test("resume: only by the parent, only after the process is gone, same id with inc + 1", () => {
	const d = withChild();
	assert.equal(d.spawn(ROOT, { resume: "a" }).ok, false, "not down yet");
	d.run({ type: "procExit", now: 0, id: "a", inc: 1, code: 1, signal: null });
	const r = d.spawn(ROOT, { resume: "a", model: "other/model" });
	assert.deepEqual(r, { ok: true, type: "spawned", id: "a", inc: 2 });
	assert.equal(d.st.agents.a.status, "starting");
	assert.equal(d.st.agents.a.spec?.model, "other/model");
});

test("idempotency: a retransmitted frame returns the cached response; a gap is rejected", () => {
	const d = withChild();
	const seq = d.nextSeq(ROOT);
	const ev: Event = { type: "send", now: 0, from: ROOT, seq, to: "a", kind: "mail", body: "x" };
	const first = d.respond(d.run(ev)).response;
	assert.deepEqual(d.respond(d.run(ev)).response, first);
	assert.equal(d.st.mailbox.a.filter((m) => m.body === "x").length, 1);
	const gap = d.respond(d.run({ ...ev, seq: seq + 5 })).response;
	assert.equal(gap.ok ? "" : gap.error, "seq_gap");
});

test("apply never mutates its input", () => {
	const d = withChild();
	const before = structuredClone(d.st);
	apply(d.st, { type: "send", now: 0, from: ROOT, seq: 99, to: "a", kind: "mail", body: "x" });
	apply(d.st, { type: "procExit", now: 0, id: "a", inc: 1, code: 1, signal: null });
	assert.deepEqual(d.st, before);
});

test("stop: every agent is killed and the root goes down; the tree finishes", () => {
	const d = withChild();
	d.run({ type: "stop", now: 0 });
	assert.equal(d.st.agents[ROOT].status, "down");
	assert.equal(d.st.agents.a.status, "killing");
	d.run({ type: "procExit", now: 0, id: "a", inc: 1, code: 143, signal: null });
	assert.equal(d.st.agents.a.reason, "killed:tree_stopped");
	assert.ok(finished(d.st));
});

test("nextDeadline tracks the earliest pending timer", () => {
	const d = withChild();
	assert.equal(nextDeadline(d.st), undefined, "all live, nothing pending");
	d.run({ type: "disconnect", now: 0, id: "a", conn: d.st.agents.a.conn });
	assert.equal(nextDeadline(d.st), TIMING.childGraceMs);
});

test("F5: a pane child's pane id is logged, so it survives replay and recover", () => {
	const d = driver();
	d.hello(ROOT, 1);
	d.spawn(ROOT, { name: "p", placement: "pane" });
	d.run({ type: "placed", id: "p", inc: 1, paneId: "w1:p9" });
	const st = recover(replay(initial("t", DEFAULT_LIMITS, 0), d.log), 0);
	assert.equal(st.agents.p.paneId, "w1:p9");
});

test("F1: a start failure ends the child with error:start_failed", () => {
	const d = driver();
	d.hello(ROOT, 1);
	d.spawn(ROOT, { name: "x" });
	d.run({ type: "procExit", now: 0, id: "x", inc: 1, code: null, signal: "start_failed" });
	assert.equal(d.st.agents.x.reason, "error:start_failed");
});
