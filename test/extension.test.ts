// src/index.ts against a fake pi host and a real broker with fake child agents (no model).
// Each test pins a finding from the code reviews (F*: 2026-10-05, N*: 2026-10-06).

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { fakeHost } from "./fixtures/host.ts";

const home = mkdtempSync("/tmp/pia-ext-");
const fake = fileURLToPath(new URL("./fixtures/fake-agent.ts", import.meta.url));
let n = 0;
const hosts: ReturnType<typeof fakeHost>[] = [];

before(() => {
	process.env.PI_ACTORS_HOME = join(home, "h");
	process.env.PI_ACTORS_SOCKET_DIR = join(home, "s");
	process.env.PI_ACTORS_CHILD_COMMAND = JSON.stringify([process.execPath, fake]);
});
after(async () => {
	for (const h of hosts) await h.fire("session_shutdown", { reason: "quit" });
	try {
		execSync(`pkill -f ${JSON.stringify(home)}`);
	} catch {}
	// Killed brokers may still be writing their last status file: retry the removal.
	await new Promise((r) => setTimeout(r, 300));
	rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function root(extra: Partial<Parameters<typeof fakeHost>[0]> = {}, keepCarry = false) {
	// One pi process has one root at a time; tests run several, so forget the carried tree.
	if (!keepCarry) rmSync(join(home, "h", "roots"), { recursive: true, force: true });
	const h = fakeHost({ cwd: home, sessionId: `s${++n}-${process.pid}`, ...extra });
	hosts.push(h);
	return h;
}

test("F2: parallel first spawns share one connection; both return and pushes keep flowing", async () => {
	const h = root();
	const results = await Promise.race([
		Promise.all([h.tool("spawn", { task: "echo", name: "a" }), h.tool("spawn", { task: "echo", name: "b" })]),
		new Promise((_, rej) => setTimeout(() => rej(new Error("a spawn hung")), 10_000)),
	]);
	assert.equal((results as unknown[]).length, 2);
	await h.waitFor(() => /echo:echo/.test(h.inbox()) && (h.inbox().match(/ended: normal/g) ?? []).length === 2);
});

test("asynchronous startup failures notify the parent after spawn returned", async () => {
	const command = process.env.PI_ACTORS_CHILD_COMMAND;
	process.env.PI_ACTORS_CHILD_COMMAND = JSON.stringify([join(home, "missing-executable")]);
	const h = root();
	try {
		assert.match((await h.tool("spawn", { task: "echo", name: "startup-failure" })).content[0].text, /Started startup-failure/);
		await h.waitFor(() => /startup-failure ended: error:start_failed/.test(h.inbox()));
		assert.equal(h.events.filter((e) => e.name === "actors:waiting").at(-1)?.data.waiting, false);
		assert.equal((h.inbox().match(/startup-failure ended/g) ?? []).length, 1);
	} finally {
		process.env.PI_ACTORS_CHILD_COMMAND = command;
	}
});

test("terminal provider errors are pushed once, clear waiting, and do not poison later runs", async () => {
	const command = process.env.PI_ACTORS_CHILD_COMMAND;
	process.env.PI_ACTORS_CHILD_COMMAND = JSON.stringify([process.execPath, fileURLToPath(new URL("./fixtures/reporting-agent.ts", import.meta.url))]);
	const h = root();
	try {
		for (const task of ["error", "partial", "fallback", "long", "retry"]) {
			await h.tool("spawn", { task, name: task });
			await h.waitFor(() => h.inbox().includes(`fixture settled: ${task}`));
			const reports = h.pushed.filter((p) => p.content.includes(`Report from ${task}:`));
			assert.equal(reports.length, 1);
			const report = reports[0].content;
			if (task === "retry") {
				assert.match(report, /Retry succeeded/);
				assert.doesNotMatch(report, /failed|configured/);
			} else {
				assert.match(report, /Run failed:/);
				assert.doesNotMatch(report, /I will investigate/);
				if (task === "fallback") assert.match(report, /unknown provider error/i);
				else if (task === "long") assert.match(report, /truncated; full text in/);
				else assert.match(report, /Provider is not configured: anthropic/);
			}
			assert.equal(h.events.filter((e) => e.name === "actors:waiting").at(-1)?.data.waiting, false);
		}
		await h.tool("send", { to: "error", text: "success" });
		await h.waitFor(() => /Recovered successfully/.test(h.inbox()));
		const recovered = h.pushed.find((p) => /Recovered successfully/.test(p.content))!;
		assert.doesNotMatch(recovered.content, /Run failed|configured/);
		await h.tool("spawn", { task: "interactive", name: "interactive" });
		await h.waitFor(() => h.inbox().includes("fixture settled: interactive"));
		assert.doesNotMatch(h.inbox(), /Report from interactive:/, "user-started pane runs are not reported");
		await h.tool("send", { to: "interactive", text: "success" });
		await h.waitFor(() => h.inbox().includes("Report from interactive:"));
		assert.match(h.pushed.find((p) => p.content.includes("Report from interactive:"))!.content, /Recovered successfully/);
	} finally {
		process.env.PI_ACTORS_CHILD_COMMAND = command;
	}
});

test("F1: a missing cwd is rejected by the tool; relative paths resolve against the agent's cwd", async () => {
	const h = root();
	await assert.rejects(h.tool("spawn", { task: "echo", cwd: "no/such/dir" }), /not a directory/);
	assert.match((await h.tool("spawn", { task: "echo", cwd: "." })).content[0].text, /Started/);
});

test("fast: a resolved model without fast mode is rejected at spawn; a resolved Anthropic model is accepted", async () => {
	const h = root();
	const models: Record<string, any> = { "x/slow": { provider: "x", id: "slow", api: "google-generative-ai" }, "anthropic/opus": { provider: "anthropic", id: "opus", api: "anthropic-messages" } };
	h.ctx.modelRegistry = { find: (p: string, id: string) => models[`${p}/${id}`] };
	await assert.rejects(h.tool("spawn", { task: "echo", model: "x/slow", fast: true }), /Anthropic or OpenAI/);
	h.ctx.model = models["x/slow"];
	await assert.rejects(h.tool("spawn", { task: "echo", fast: true }), /Anthropic or OpenAI/);
	assert.match((await h.tool("spawn", { task: "echo", model: "anthropic/opus", fast: true })).content[0].text, /Started/);
});

test("fast: the payload rewrite reads actors-fast per request, set after the extension loads", async () => {
	const flags: Record<string, string> = {};
	const h = root({ flags });
	h.ctx.model = { provider: "openai", id: "gpt", api: "openai-responses" };
	const req = (payload: unknown) => h.handlers.before_provider_request[0]({ type: "before_provider_request", payload }, h.ctx);
	assert.equal(await req({ model: "m" }), undefined);
	flags["actors-fast"] = "1";
	assert.deepEqual(await req({ model: "m" }), { model: "m", service_tier: "priority" });
	h.ctx.model = { provider: "anthropic", id: "opus", api: "anthropic-messages" };
	assert.deepEqual(await req({ model: "m" }), { model: "m", speed: "fast", betas: ["fast-mode-2026-02-01"] });
});

test("F4: a push that pi dropped (queue cleared) is redelivered after the agent settles", async () => {
	const h = root();
	h.setPush("drop");
	await h.tool("spawn", { task: "serve", name: "srv" });
	await h.tool("send", { to: "srv", text: "ping" });
	await h.waitFor(() => /echo:ping/.test(h.inbox()));
	const before = h.pushed.length;
	h.setPush("persist");
	await new Promise((r) => setTimeout(r, 5200)); // reclaim only what has been in flight for a while
	await h.fire("agent_settled");
	await h.waitFor(() => h.pushed.length > before && /echo:ping/.test(h.pushed.at(-1)!.content));
});

test("mail that arrives during a run waits in the broker and reaches pi as one batch, in order, at the run's last turn", async () => {
	// pi hands queued deliveries to the model one per turn (followUpMode/steeringMode "one-at-a-time"):
	// one injection per message let a busy agent's queue grow without bound and surface stale
	// messages after newer urgent ones (incident 2026-10-18).
	const h = root();
	await h.tool("spawn", { task: "serve", name: "busy-q" });
	const mailbox = () => {
		try {
			return JSON.parse(readFileSync(join(home, "h", "trees", treeOf(h), "status.json"), "utf8")).agents.find((a: { id: string }) => a.id === "root")?.mailbox;
		} catch {
			return undefined;
		}
	};
	await h.fire("agent_start");
	h.setPush("keep"); // a busy pi queues injections instead of persisting them
	const before = h.pushed.length;
	for (const n of [1, 2, 3, 4, 5]) await h.tool("send", { to: "busy-q", text: `m${n}` });
	await h.waitFor(() => mailbox() === 5);
	assert.equal(h.pushed.length, before, "nothing is queued in pi mid-run");
	// A turn that called tools is not the last one: the mail keeps waiting.
	await h.fire("turn_end", { message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "t", name: "bash", arguments: {} }] }, toolResults: [] });
	assert.equal(h.pushed.length, before);
	await h.fire("turn_end", { message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] }, toolResults: [] });
	assert.equal(h.pushed.length, before + 1, "one injection for the whole backlog");
	const batch = h.pushed.at(-1)!;
	assert.equal(batch.options.deliverAs, "followUp");
	assert.match(batch.content, /echo:m1[\s\S]*echo:m2[\s\S]*echo:m3[\s\S]*echo:m4[\s\S]*echo:m5/);

	// While that batch is still in pi's queue, newer mail (urgent too) waits behind it, then goes
	// as one steer that keeps the older message first.
	await h.tool("send", { to: "busy-q", text: "older" });
	await h.tool("send", { to: "busy-q", text: "urgent:grant" });
	await h.waitFor(() => mailbox() === 7);
	assert.equal(h.pushed.length, before + 1, "never a second delivery queued behind an unconsumed one");
	h.drainQueue(); // pi hands the batch to the model
	await h.fire("turn_end", { message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "t2", name: "bash", arguments: {} }] }, toolResults: [] });
	assert.equal(h.pushed.length, before + 2);
	const urgent = h.pushed.at(-1)!;
	assert.equal(urgent.options.deliverAs, "steer");
	assert.match(urgent.content, /echo:older[\s\S]*echo:urgent:grant/);
	assert.doesNotMatch(urgent.content, /echo:m\d/, "nothing delivered twice");
	h.drainQueue();
	h.setPush("persist");
	await h.fire("agent_settled", { aborted: false });
	await h.waitFor(() => mailbox() === 0, 5000);

	// An urgent message to a busy agent with nothing queued goes at once, as a steer.
	await h.fire("agent_start");
	await h.tool("send", { to: "busy-q", text: "urgent:now" });
	await h.waitFor(() => /echo:urgent:now/.test(h.inbox()));
	assert.equal(h.pushed.at(-1)!.options.deliverAs, "steer");
	await h.fire("agent_settled", { aborted: false });
});

test("INV-4: an urgent message to a busy agent never overtakes older mail from the same sender", async () => {
	// Incident 2026-10-18: bpe-finish's urgent 2:66 reached the root model before its 2:54..2:65.
	const h = root();
	await h.tool("spawn", { task: "serve", name: "fifo" });
	await h.fire("agent_start");
	h.setPush("keep");
	await h.tool("send", { to: "fifo", text: "wait for approval" });
	await new Promise((r) => setTimeout(r, 500));
	await h.tool("send", { to: "fifo", text: "urgent:approved" });
	await h.waitFor(() => /echo:urgent:approved/.test(h.inbox()));
	h.drainQueue(); // pi: steering first, then follow-ups
	const seen = (await h.context()).flatMap((m: any) => m.details.actors.messages.map((x: { body: string }) => x.body));
	assert.deepEqual(seen, ["echo:wait for approval", "echo:urgent:approved"]);
	h.setPush("persist");
	await h.fire("agent_settled", { aborted: false });
});

test("stress: floods of ordinary and urgent mail to a busy agent, through tool turns, pi clearing its queue, a broker crash and a child resume: one delivery in pi at a time, each message once, in sender order", async () => {
	const h = root();
	let seed = 20261018;
	const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
	const kids = ["st-a", "st-b", "st-c"];
	for (const k of kids) await h.tool("spawn", { task: "serve", name: k });
	const status = () => {
		try {
			return JSON.parse(readFileSync(join(home, "h", "trees", treeOf(h), "status.json"), "utf8"));
		} catch {
			return undefined;
		}
	};
	const tick = () => new Promise((r) => setTimeout(r, 40));
	const toolTurn = { message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "t", name: "bash", arguments: {} }] }, toolResults: [] };
	const lastTurn = { message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }] }, toolResults: [] };
	const expected: string[] = [];
	let maxQueued = 0;
	await h.fire("agent_start");
	h.setPush("keep");
	for (let i = 0; i < 70; i++) {
		if (i === 25) {
			// The broker crashes with a delivery possibly in pi's queue; the root relaunches it.
			process.kill(status().pid, "SIGKILL");
			await new Promise((r) => setTimeout(r, 300));
		}
		if (i === 40) {
			// Stop a child once it has answered everything (mail a stopped child never read is dropped
			// by design), then resume it. Its end notice is the root's own doing, even if it arrives
			// after the resume.
			const answered = () => {
				const evs = readFileSync(join(home, "h", "trees", treeOf(h), "events.log"), "utf8").split("\n").filter((l) => l.includes('"type":"send"'));
				return evs.filter((l) => l.includes('"from":"st-c"')).length === evs.filter((l) => l.includes('"to":"st-c"')).length;
			};
			await h.waitFor(answered, 15_000);
			await h.tool("stop", { id: "st-c" });
			for (let t = 0; ; t++) {
				const r = await h.tool("spawn", { task: "serve", resume: "st-c" }).then(() => true, () => false);
				if (r) break;
				assert.ok(t < 100, "st-c could not be resumed");
				await new Promise((r) => setTimeout(r, 100));
			}
		}
		if (i === 55) {
			// Esc: pi clears its queues; the run settles and, once old enough, the lost delivery is reclaimed.
			h.clearQueue();
			await h.fire("agent_settled", { aborted: true });
			await new Promise((r) => setTimeout(r, 5200));
			await h.fire("agent_settled", { aborted: true });
			await h.fire("agent_start");
		}
		const x = rnd();
		if (x < 0.45) {
			const kid = kids[Math.floor(rnd() * kids.length)];
			const body = `${rnd() < 0.3 ? "urgent:" : ""}${kid}#${i}`;
			await h.tool("send", { to: kid, text: body });
			expected.push(`echo:${body}`);
		} else if (x < 0.65) await h.fire("turn_end", toolTurn);
		else if (x < 0.8) await h.fire("turn_end", lastTurn);
		else if (x < 0.95) h.drainQueue();
		else {
			h.drainQueue();
			await h.fire("agent_settled", { aborted: false });
			await tick();
			await h.fire("agent_start");
		}
		await tick();
		maxQueued = Math.max(maxQueued, h.queuedCount());
	}
	h.setPush("persist");
	h.drainQueue();
	await h.fire("agent_settled", { aborted: false });
	const consumed = async () =>
		(await h.context()).flatMap((m: any) => m.details.actors.messages as { from: string; body: string }[]).filter((m) => m.body.startsWith("echo:"));
	for (let t = 0; (await consumed()).length < expected.length; t++) {
		assert.ok(t < 200, `missing: ${expected.filter((e) => !h.inbox().includes(e)).join(", ")} ${JSON.stringify(status()?.agents.map((a: any) => [a.id, a.status, a.inc, a.mailbox]))}`);
		await new Promise((r) => setTimeout(r, 100));
		await h.fire("agent_settled", { aborted: false });
	}
	const got = await consumed();
	assert.deepEqual([...got.map((m) => m.body)].sort(), [...expected].sort(), "every message consumed exactly once");
	assert.doesNotMatch(JSON.stringify(await h.context()), /st-c ended/, "the end of a child it stopped is not news to the root");
	assert.ok(maxQueued <= 1, `at most one delivery waits in pi's queue (saw ${maxQueued})`);
	for (const kid of kids) {
		const order = got.filter((m) => m.from === kid).map((m) => Number(m.body.split("#")[1]));
		assert.deepEqual(order, [...order].sort((a, b) => a - b), `${kid}: consumed in sender order`);
	}
	await h.waitFor(() => status()?.agents.find((a: { id: string }) => a.id === "root")?.mailbox === 0, 5000);
});

test("F8: an oversized message is refused up front and does not break later sends", async () => {
	const h = root();
	await h.tool("spawn", { task: "serve", name: "big" });
	await assert.rejects(h.tool("send", { to: "big", text: "x".repeat(70_000) }), /too large/);
	assert.match((await h.tool("send", { to: "big", text: "small" })).content[0].text, /Sent/);
	await h.waitFor(() => /echo:small/.test(h.inbox()));
});

test("F12: waiting is tracked for direct children only, and cleared when they report or end", async () => {
	const h = root();
	const waiting = () => h.events.filter((e) => e.name === "actors:waiting").at(-1)?.data.waiting;
	await h.tool("spawn", { task: "echo", name: "w" });
	assert.equal(waiting(), true);
	await h.waitFor(() => /w ended/.test(h.inbox()));
	assert.equal(waiting(), false);
	await h.tool("send", { to: "nobody-of-mine", text: "hi" }).catch(() => {});
	assert.equal(waiting(), false, "a failed or non-child send never sets waiting");
});

test("F7: after /actors stop, the next spawn starts a fresh tree instead of failing forever", async () => {
	const h = root();
	await h.tool("spawn", { task: "serve", name: "s1" });
	await h.command("actors", "stop");
	await new Promise((r) => setTimeout(r, 1500));
	assert.match((await h.tool("spawn", { task: "echo", name: "again" })).content[0].text, /Started again/);
	await h.waitFor(() => /again ended: normal/.test(h.inbox()));
});

test("F11: a root session switch (/fork) keeps the tree (children's reports reach the new session)", async () => {
	const sessionA = root();
	await sessionA.tool("spawn", { task: "serve", name: "keep" });
	await sessionA.fire("session_shutdown", { reason: "fork" });
	// pi replaces the extension runtime in the same process; the new session has no tree entry.
	const sessionB = root({}, true);
	await sessionB.fire("session_start", { reason: "fork" });
	await sessionB.tool("send", { to: "keep", text: "still there?" });
	await sessionB.waitFor(() => /echo:still there\?/.test(sessionB.inbox()));
});

const lastNote = (h: ReturnType<typeof fakeHost>) => h.notes.at(-1) ?? "";
const treeOf = (h: ReturnType<typeof fakeHost>) => h.entries.filter((e) => e.type === "custom" && e.customType === "pi-actors-root").at(-1)?.data.treeId;

test("N1: pi keeping an injection that was also redelivered does not show the model the message twice", async () => {
	const h = root();
	await h.tool("spawn", { task: "serve", name: "k" });
	h.setPush("keep");
	await h.tool("send", { to: "k", text: "once" });
	await h.waitFor(() => /echo:once/.test(h.inbox()));
	h.setPush("persist");
	await new Promise((r) => setTimeout(r, 5200));
	await h.fire("agent_settled"); // looks lost: redelivered and persisted
	await h.waitFor(() => h.entries.some((e) => e.type === "custom_message" && /echo:once/.test(e.content)));
	h.drainQueue(); // ...and then pi delivers the copy it kept
	const seen = (await h.context()).filter((m: any) => /echo:once/.test(m.content));
	assert.equal(seen.length, 1);
});

test("N4: a session switch (/resume) into a session that recorded another tree keeps the running tree", async () => {
	const other = root();
	await other.tool("spawn", { task: "echo", name: "x" });
	const otherTree = treeOf(other);
	await other.fire("session_shutdown", { reason: "quit" });
	const a = root();
	await a.tool("spawn", { task: "serve", name: "keep2" });
	await a.fire("session_shutdown", { reason: "resume" });
	const b = root({}, true);
	b.entries.push({ type: "custom", customType: "pi-actors-root", data: { treeId: otherTree } });
	await b.fire("session_start", { reason: "resume" });
	await b.tool("send", { to: "keep2", text: "here?" });
	await b.waitFor(() => /echo:here\?/.test(b.inbox()));
});

test("N8: a carry file left by an earlier process with the same pid is ignored", async () => {
	rmSync(join(home, "h", "roots"), { recursive: true, force: true });
	mkdirSync(join(home, "h", "roots"), { recursive: true });
	writeFileSync(join(home, "h", "roots", `${process.pid}.json`), JSON.stringify({ treeId: "0123456789", started: 1 }));
	const h = root({}, true);
	await h.tool("spawn", { task: "echo", name: "fresh" });
	assert.notEqual(treeOf(h), "0123456789");
});

const children = (h: ReturnType<typeof fakeHost>) => h.command("actors").then(() => lastNote(h));

test("/new stops the whole tree; the new session starts a fresh one", async () => {
	const a = root();
	await a.tool("spawn", { task: "serve", name: "old" });
	const oldTree = treeOf(a);
	await a.fire("session_shutdown", { reason: "new" });
	const b = root({}, true);
	await b.fire("session_start", { reason: "new" });
	await assert.rejects(b.tool("send", { to: "old", text: "there?" }), /unknown_target|no parent/);
	await b.tool("spawn", { task: "echo", name: "next" });
	assert.notEqual(treeOf(b), oldTree);
	assert.doesNotMatch(await children(b), /old/);
	// The old tree really stopped, rather than waiting out the root's 5-minute grace.
	const status = join(home, "h", "trees", oldTree, "status.json");
	for (let i = 0; ; i++) {
		try {
			if (JSON.parse(readFileSync(status, "utf8")).finished === true) break;
		} catch {}
		assert.ok(i < 100, "the old tree did not finish");
		await new Promise((r) => setTimeout(r, 100));
	}
});

test("stopping a child is silent; an end the agent did not cause is pushed", async () => {
	const h = root();
	await h.tool("spawn", { task: "serve", name: "quiet" });
	await h.tool("stop", { id: "quiet" });
	await h.tool("spawn", { task: "crash", name: "loud" });
	await h.waitFor(() => /loud ended: error:crashed/.test(h.inbox()));
	while (!/quiet {2}stopped/.test(await children(h))) await new Promise((r) => setTimeout(r, 200));
	assert.doesNotMatch(h.inbox(), /quiet ended/);
	assert.equal(h.events.filter((e) => e.name === "actors:waiting").at(-1)?.data.waiting, false);
});

test("/actors clear removes ended agents (and their subtrees) but leaves running ones", async () => {
	const h = root();
	await h.tool("spawn", { task: "echo", name: "done1" });
	await h.tool("spawn", { task: "serve", name: "busy" });
	await h.waitFor(() => /done1 ended: normal/.test(h.inbox()));
	await h.command("actors", "clear");
	assert.match(lastNote(h), /Cleared 1 ended subtree/);
	const tree = await children(h);
	assert.doesNotMatch(tree, /done1/);
	assert.match(tree, /busy {2}running/);
	await h.command("actors", "clear");
	assert.match(lastNote(h), /No ended agents/);
});

test("panel: kitty-encoded keys work; x on the ended row clears every ended agent while the panel stays open", async () => {
	const h = root({ mode: "tui" });
	await h.fire("session_start", { reason: "startup" });
	await h.tool("spawn", { task: "echo", name: "gone" });
	await h.tool("spawn", { task: "serve", name: "here" });
	await h.waitFor(() => /gone ended: normal/.test(h.inbox()));
	void h.command("actors");
	await h.waitFor(() => h.overlayOpen());
	assert.match(h.overlayLines().join("\n"), /▸ 1 ended/);
	h.press("down"); // to the ended row
	assert.match(h.overlayLines().join("\n"), /x clear all ended/);
	h.press("\x1b[120u"); // "x" under the kitty keyboard protocol
	await h.waitFor(() => !/ended/.test(h.overlayLines().join("\n")));
	assert.ok(h.overlayOpen(), "the panel stays open");
	assert.match(h.overlayLines().join("\n"), /here {2}running/);
	h.press("\x1b[102u"); // "f" on a headless agent explains instead of doing nothing
	assert.match(lastNote(h), /headless/);
	h.press("escape");
	assert.equal(h.overlayOpen(), false);
});

test("a delivery renders as one collapsed line; expanded shows what the model read", async () => {
	const h = root();
	await h.tool("spawn", { task: "echo", name: "r" });
	await h.waitFor(() => /r ended: normal/.test(h.inbox()));
	const p = h.pushed.find((x) => /echo:echo/.test(x.content))!;
	assert.doesNotMatch(p.content, /\[pi-actors\]|Reply with send/, "no header or footer");
	const theme = { fg: (_c: string, t: string) => t };
	const collapsed = h.renderers["pi-actors"]({ content: p.content, details: p.details }, { expanded: false, outputPad: 0 }, theme).render(200).join("\n");
	assert.match(collapsed, /⇢ message from r/);
	assert.doesNotMatch(collapsed, /echo:echo/);
	const expanded = h.renderers["pi-actors"]({ content: p.content, details: p.details }, { expanded: true, outputPad: 0 }, theme).render(200).join("\n");
	assert.match(expanded, /echo:echo/);
});

test("in tui, the widget counts subagents executing a run, hides when none is, and clears when the tree stops", async () => {
	const h = root({ mode: "tui" });
	await h.fire("session_start", { reason: "startup" });
	const widget = () => h.widgets["pi-actors"]?.[0];
	await h.tool("spawn", { task: "serve", name: "w1" });
	await h.tool("spawn", { task: "serve", name: "w2" });
	await h.tool("send", { to: "w1", text: "hi" });
	await h.waitFor(() => /echo:hi/.test(h.inbox()));
	await new Promise((r) => setTimeout(r, 5500)); // one widget refresh with both children idle
	assert.equal(widget(), undefined, "idle children are not running");
	await h.tool("send", { to: "w1", text: "busy" });
	await h.waitFor(() => widget() === "pi-actors · 1 subagent running", 8000);
	await h.tool("send", { to: "w2", text: "busy" });
	await h.waitFor(() => widget() === "pi-actors · 2 subagents running", 8000);
	await h.tool("send", { to: "w2", text: "idle" });
	await h.waitFor(() => widget() === "pi-actors · 1 subagent running", 8000);
	await h.tool("stop", { id: "w1" });
	await h.waitFor(() => widget() === undefined, 8000);
	await h.command("actors", "stop");
	await h.waitFor(() => h.widgets["pi-actors"] === undefined, 8000);
});

test("an agent's run state follows agent_start and agent_settled, and is reported by the broker", async () => {
	const h = root();
	await h.tool("spawn", { task: "serve", name: "rs" });
	const status = () => {
		try {
			return JSON.parse(readFileSync(join(home, "h", "trees", treeOf(h), "status.json"), "utf8"));
		} catch {
			return undefined;
		}
	};
	const rootRunning = () => status()?.agents.find((a: { id: string }) => a.id === "root")?.running;
	await h.fire("agent_start");
	await h.waitFor(() => rootRunning() === true, 5000);
	await h.fire("agent_settled");
	await h.waitFor(() => rootRunning() === false, 5000);
});

test("a session switch keeps the tree even when the process uptime clock jumped (system sleep)", async () => {
	const a = root();
	await a.tool("spawn", { task: "serve", name: "sleeper" });
	await a.fire("session_shutdown", { reason: "resume" });
	const uptime = process.uptime;
	process.uptime = () => uptime() - 3600; // an hour of sleep, as the monotonic clock sees it
	try {
		const b = root({}, true);
		await b.fire("session_start", { reason: "resume" });
		await b.tool("send", { to: "sleeper", text: "awake?" });
		await b.waitFor(() => /echo:awake\?/.test(b.inbox()));
	} finally {
		process.uptime = uptime;
	}
});

// Issue #6: tool text states what the tools do, accurately and once; workflow policy is left to the project.
const toolText = (t: any) => [
	t.description,
	t.promptSnippet,
	...(t.promptGuidelines ?? []),
	...Object.values(t.parameters.properties).map((p: any) => p.description).filter(Boolean),
] as string[];

// When to spawn, fork and stop is lifecycle guidance the tools give; reporting and escalation stay with workflows.
test("#6: no tool text prescribes what to report or how to escalate", () => {
	const h = root();
	const policy = /escalat|quote|forward|decision|ask the user|final answer should/i;
	for (const name of ["spawn", "send", "stop"]) for (const s of toolText(h.tools[name])) assert.doesNotMatch(s, policy, `${name}: ${s}`);
});

test("tool text guides the child lifecycle: fork, pane and stop", () => {
	const t = root().tools;
	const g = (name: string) => (t[name].promptGuidelines ?? []).join(" ");
	assert.match(g("spawn"), /do small tasks yourself/i);
	assert.match(g("spawn"), /fork only if the child needs this conversation/i);
	assert.match(g("spawn"), /pane only when the user asks/i);
	assert.match(g("stop"), /stop each child once you need nothing more from it/i);
});

test("#6: no fact appears twice across a tool's description, summary, guidelines and parameters", () => {
	const h = root();
	const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
	for (const name of ["spawn", "send", "stop"]) {
		const t = h.tools[name];
		assert.ok(!t.promptSnippet.startsWith(`${name}:`), `pi already prefixes the snippet with "${name}:"`);
		const seen = new Map<string, number>();
		// Field by field, sentence by sentence: a 4-word run shared by two of them restates a fact.
		const parts = toolText(t).flatMap((field) => field.split(/(?<=[.;:])\s+/));
		parts.forEach((part, i) => {
			const w = words(part);
			for (let k = 0; k + 4 <= w.length; k++) {
				const g = w.slice(k, k + 4).join(" ");
				const j = seen.get(g);
				assert.ok(j === undefined || j === i, `${name}: "${g}" in both "${parts[j!]}" and "${part}"`);
				seen.set(g, i);
			}
		});
	}
});

test("#6: send says any agent in the tree is reachable and the user only through the parent", () => {
	const d = root().tools.send.description;
	assert.match(d, /any agent in your tree/);
	assert.match(d, /only the root agent can reach the user/i);
	assert.match(d, /through its parent/);
	assert.match(d, /over 16K characters arrives cut/, "delivery cuts long messages (mailroom formatOne)");
	for (const name of ["spawn", "send", "stop"]) for (const s of toolText(root().tools[name])) assert.doesNotMatch(s, /KiB/, `${name}: limits are in characters`);
	assert.doesNotMatch(root().tools.send.promptSnippet, /child or your parent/);
});

test("#6: spawn says reports over 16K characters are cut and name the session file with the full text", () => {
	const d = root().tools.spawn.description;
	assert.match(d, /over 16K characters/, "the cut counts characters (mailroom INLINE_LIMIT), not bytes");
	assert.match(d, /session file/);
	assert.match(d, /continue it with send/);
	assert.match(root().tools.spawn.parameters.properties.resume.description, /ended child/);
});

test("a tool call whose signal is already aborted does not start anything", async () => {
	const h = root();
	await assert.rejects(h.tools.spawn.execute("c1", { task: "echo", name: "never" }, AbortSignal.abort(), undefined, h.ctx), /abort/i);
	assert.equal(h.pushed.length, 0);
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(treeOf(h), undefined, "no tree was started or recorded");
});
