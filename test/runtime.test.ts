import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { closeOwnPaneOnExit, detectMux, ensurePrivateDir } from "../src/runtime.ts";

const tmp = mkdtempSync("/tmp/pia-rt-");
after(() => rmSync(tmp, { recursive: true, force: true }));
const runtime = fileURLToPath(new URL("../src/runtime.ts", import.meta.url));

test("F6: the socket directory must be ours, private and not a symlink", () => {
	const ok = join(tmp, "ok");
	ensurePrivateDir(ok);
	const open = join(tmp, "open");
	mkdirSync(open);
	chmodSync(open, 0o777);
	assert.throws(() => ensurePrivateDir(open), /accessible to other users/);
	const link = join(tmp, "link");
	symlinkSync(ok, link);
	assert.throws(() => ensurePrivateDir(link), /not a plain directory/);
});

test("F3: of many processes racing for the broker lock, exactly one wins", async () => {
	for (let round = 0; round < 5; round++) {
		const dir = join(tmp, `race${round}`);
		mkdirSync(dir);
		const file = join(tmp, `race${round}.mjs`);
		writeFileSync(file, `import { acquireLock } from ${JSON.stringify(pathToFileURL(runtime).href)};
const start = Number(process.argv[2]); while (Date.now() < start) {}
console.log(acquireLock(${JSON.stringify(dir)}) ? "WON" : "lost");
setTimeout(() => {}, 1000);`);
		const start = Date.now() + 1500;
		const outs = await Promise.all(Array.from({ length: 10 }, () => new Promise<string>((resolve) => {
			const p = spawn(process.execPath, [file, String(start)]);
			let out = "";
			p.stdout.on("data", (d) => (out += d));
			p.stderr.on("data", (d) => (out += d));
			p.on("close", () => resolve(out));
		})));
		assert.equal(outs.filter((o) => o.includes("WON")).length, 1, outs.join("|"));
	}
});

test("the innermost multiplexer wins: tmux inside herdr places panes in tmux", () => {
	assert.deepEqual(detectMux({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2", TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%3" }), { mux: "tmux", pane: "%3" });
	assert.deepEqual(detectMux({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2" }), { mux: "herdr", pane: "w1:p2" });
	assert.equal(detectMux({}), undefined);
});

test("N2: racing to take over a stale lock (dead pid), exactly one contender wins", async () => {
	let multi = 0;
	for (let round = 0; round < 6; round++) {
		const dir = join(tmp, `stale${round}`);
		mkdirSync(dir);
		writeFileSync(join(dir, "broker.lock"), JSON.stringify({ pid: 999_999, bootTime: Math.round(Date.now() / 1000) }));
		const file = join(tmp, `stale${round}.mjs`);
		writeFileSync(file, `import { acquireLock } from ${JSON.stringify(pathToFileURL(runtime).href)};
const start = Number(process.argv[2]); while (Date.now() < start) {}
console.log(acquireLock(${JSON.stringify(dir)}) ? "WON" : "lost");
setTimeout(() => {}, 1000);`);
		const start = Date.now() + 1200;
		const outs = await Promise.all(Array.from({ length: 16 }, () => new Promise<string>((resolve) => {
			// A 30 ms pause between "this lock is stale" and replacing it makes the race certain to bite.
			const p = spawn(process.execPath, [file, String(start)], { env: { ...process.env, PI_ACTORS_TEST_LOCK_PAUSE_MS: "30" } });
			let out = "";
			p.stdout.on("data", (d) => (out += d));
			p.stderr.on("data", (d) => (out += d));
			p.on("close", () => resolve(out));
		})));
		const won = outs.filter((o) => o.includes("WON")).length;
		if (won > 1) multi++;
		assert.ok(won <= 1, `round ${round}: ${won} winners`);
	}
	assert.equal(multi, 0);
});

test("a broker that lost its lock stops without removing the socket of the broker that took over", async () => {
	const { ensureBroker } = await import("../src/client/launcher.ts");
	const { treeDir, socketPath } = await import("../src/runtime.ts");
	const { createServer, connect } = await import("node:net");
	const { readFileSync } = await import("node:fs");
	const home = mkdtempSync("/tmp/pia-lock-");
	const saved = { h: process.env.PI_ACTORS_HOME, s: process.env.PI_ACTORS_SOCKET_DIR };
	process.env.PI_ACTORS_HOME = join(home, "h");
	process.env.PI_ACTORS_SOCKET_DIR = join(home, "s");
	const treeId = "lostlock01";
	try {
		const sock = await ensureBroker({ treeId, rootCwd: home });
		const dir = treeDir(treeId);
		const oldPid = JSON.parse(readFileSync(join(dir, "broker.lock"), "utf8")).pid as number;
		// Another broker took over: it holds the lock and listens on the same path.
		rmSync(sock, { force: true });
		const winner = createServer((c) => c.end());
		await new Promise<void>((r) => winner.listen(sock, r));
		writeFileSync(join(dir, "broker.lock"), JSON.stringify({ pid: process.pid, bootTime: 0 }));
		const gone = async () => {
			for (let i = 0; i < 50; i++) {
				try { process.kill(oldPid, 0); } catch { return; }
				await new Promise((r) => setTimeout(r, 100));
			}
			throw new Error("the old broker did not stop");
		};
		await gone();
		await new Promise<void>((resolve, reject) => connect(sock).on("connect", resolve).on("error", reject));
		winner.close();
		assert.equal(socketPath(treeId), sock);
	} finally {
		process.env.PI_ACTORS_HOME = saved.h;
		process.env.PI_ACTORS_SOCKET_DIR = saved.s;
		rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("a broker that lost its lock writes nothing more to the log, not even before its next lock check", async () => {
	const { ensureBroker } = await import("../src/client/launcher.ts");
	const { treeDir } = await import("../src/runtime.ts");
	const { Client } = await import("../src/client/connection.ts");
	const { readFileSync } = await import("node:fs");
	const home = mkdtempSync("/tmp/pia-lock-");
	const saved = { h: process.env.PI_ACTORS_HOME, s: process.env.PI_ACTORS_SOCKET_DIR };
	process.env.PI_ACTORS_HOME = join(home, "h");
	process.env.PI_ACTORS_SOCKET_DIR = join(home, "s");
	const treeId = "lostlock02";
	let root: InstanceType<typeof Client> | undefined;
	try {
		const socket = await ensureBroker({ treeId, rootCwd: home });
		root = new Client({ socket, id: "root", inc: 1, pid: process.pid, sessionId: "S" }, 2000);
		await root.start();
		const dir = treeDir(treeId);
		const oldPid = JSON.parse(readFileSync(join(dir, "broker.lock"), "utf8")).pid as number;
		writeFileSync(join(dir, "broker.lock"), JSON.stringify({ pid: process.pid, bootTime: 0 }));
		void root.op("send", { to: "human", kind: "mail", body: "after the takeover" }).catch(() => {});
		await new Promise((r) => setTimeout(r, 300));
		assert.doesNotMatch(readFileSync(join(dir, "events.log"), "utf8"), /after the takeover/);
		try {
			process.kill(oldPid, "SIGKILL");
		} catch {}
	} finally {
		root?.close();
		process.env.PI_ACTORS_HOME = saved.h;
		process.env.PI_ACTORS_SOCKET_DIR = saved.s;
		rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("a pane child that lost its tree closes exactly its own pane on exit, and only with a pane id", () => {
	const calls: string[][] = [];
	const before = process.listeners("exit").length;
	closeOwnPaneOnExit(undefined, (bin, args) => calls.push([bin, ...args]));
	closeOwnPaneOnExit("", (bin, args) => calls.push([bin, ...args]));
	assert.equal(process.listeners("exit").length, before, "a headless child (no pane id) registers nothing");
	closeOwnPaneOnExit("w1:p9", (bin, args) => calls.push([bin, ...args]));
	const hook = process.listeners("exit").at(-1) as () => void;
	process.removeListener("exit", hook);
	hook();
	assert.deepEqual(calls, [[process.env.HERDR_BIN ?? "herdr", "pane", "close", "w1:p9"]]);
});
