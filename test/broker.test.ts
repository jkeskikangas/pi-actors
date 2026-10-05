// Model-free integration: a real broker (started by the Launcher from a runtime snapshot), real
// Keepers, and fake agent processes (test/fixtures/fake-agent.ts) that speak the protocol.

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "../src/client/connection.ts";
import { ensureBroker } from "../src/client/launcher.ts";
import type { Message } from "../src/protocol.ts";
import { treeDir } from "../src/runtime.ts";

const home = mkdtempSync("/tmp/pia-home-");
const fake = fileURLToPath(new URL("./fixtures/fake-agent.ts", import.meta.url));
let treeN = 0;

before(() => {
	process.env.PI_ACTORS_HOME = home;
	process.env.PI_ACTORS_SOCKET_DIR = join(home, "s");
});
const clients: Client[] = [];
after(() => {
	for (const c of clients) c.close();
	// Kill everything this suite started, even after a failed test.
	try {
		execSync(`pkill -f ${JSON.stringify(home)}`);
	} catch {
		// nothing left
	}
	rmSync(home, { recursive: true, force: true });
});

async function tree() {
	const treeId = `t${++treeN}${process.pid % 1000}`;
	const socket = await ensureBroker({ treeId, rootCwd: home, childCommand: [process.execPath, fake] });
	const root = new Client({ socket, id: "root", inc: 1, pid: process.pid, sessionId: "S" }, 5000);
	clients.push(root);
	await root.start();
	return { treeId, socket, root };
}

// At-least-once: an ack lost in a broker crash means redelivery. Like the real client, the test
// drops message ids it has already consumed.
const consumed = new WeakMap<Client, Set<string>>();

async function receive(c: Client, filter: Parameters<Client["fetch"]>[0] = {}, ms = 15_000): Promise<Message> {
	const end = Date.now() + ms;
	const seen = consumed.get(c) ?? new Set<string>();
	consumed.set(c, seen);
	while (Date.now() < end) {
		const m = await c.fetch(filter);
		if (m && seen.has(m.id)) {
			c.ack(m.id);
			continue;
		}
		if (m) {
			seen.add(m.id);
			c.ack(m.id);
			return m;
		}
		await c.waitForMail(200);
	}
	throw new Error(`no message matching ${JSON.stringify(filter)} within ${ms} ms`);
}

const spawnReq = (task: string) => ({ req: { task, context: "fresh", placement: "headless" } });

test("spawn → child mail → exit → DOWN normal with result", async () => {
	const { root } = await tree();
	const r = await root.op("spawn", spawnReq("echo"));
	assert.equal(r.ok, true);
	const mail = await receive(root, { kind: "mail" });
	assert.equal(mail.body, "echo:echo");
	const down = JSON.parse((await receive(root, { kind: "down" })).body);
	assert.deepEqual([down.reason, down.result], ["normal", "echoed"]);
	root.stopTree();
	root.close();
});

test("request/reply composes from send{call} + receive{ref}; replies never reach a plain receive", async () => {
	const { root } = await tree();
	const r = (await root.op("spawn", spawnReq("serve"))) as { id: string };
	const sent = (await root.op("send", { to: r.id, kind: "call", body: "q1", timeoutS: 30 })) as { msgId: string };
	assert.equal((await receive(root, { ref: sent.msgId })).body, "re:q1");
	await root.op("send", { to: r.id, kind: "mail", body: "bye" });
	const down = JSON.parse((await receive(root, { kind: "down" })).body);
	assert.equal(down.result, "served");
	root.stopTree();
	root.close();
});

test("a crashed child produces DOWN error:crashed", async () => {
	const { root } = await tree();
	await root.op("spawn", spawnReq("crash"));
	const down = JSON.parse((await receive(root, { kind: "down" })).body);
	assert.match(down.reason, /^error:crashed\(3\)/);
	root.stopTree();
	root.close();
});

test("exit{target} by an ancestor kills a child", async () => {
	const { root } = await tree();
	const r = (await root.op("spawn", spawnReq("serve"))) as { id: string };
	await root.op("send", { to: r.id, kind: "call", body: "ping", timeoutS: 30 }).then((x) => receive(root, { ref: (x as { msgId: string }).msgId }));
	assert.equal((await root.op("kill", { target: r.id })).ok, true);
	const down = JSON.parse((await receive(root, { kind: "down" })).body);
	assert.match(down.reason, /^killed/);
	root.stopTree();
	root.close();
});

test("broker SIGKILL: the child survives under its Keeper, everyone reconnects, messages flow again", async () => {
	const { treeId, root } = await tree();
	const r = (await root.op("spawn", spawnReq("serve"))) as { id: string };
	await root.op("send", { to: r.id, kind: "mail", body: "before" });
	assert.equal((await receive(root, { kind: "mail" })).body, "echo:before");
	const lock = JSON.parse(readFileSync(join(treeDir(treeId), "broker.lock"), "utf8"));
	process.kill(lock.pid, "SIGKILL");
	await new Promise((r) => setTimeout(r, 300));
	await ensureBroker({ treeId, rootCwd: home }); // the root's Launcher restarts it
	await new Promise<void>((res) => (root.connected ? res() : root.once("welcome", () => res())));
	await root.op("send", { to: r.id, kind: "mail", body: "after" });
	assert.equal((await receive(root, { kind: "mail" })).body, "echo:after", "same child, same mailbox, after the crash");
	await root.op("send", { to: r.id, kind: "mail", body: "bye" });
	const down = JSON.parse((await receive(root, { kind: "down" })).body);
	assert.equal(down.reason, "normal");
	root.stopTree();
	root.close();
});
