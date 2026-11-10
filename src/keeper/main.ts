// Keeper: OS parent of one headless child (design D8).
// - starts the child detached in its own process group, with no shell;
// - holds the child's stdin open (RPC pi exits when stdin closes) and answers extension dialogs
//   with "cancelled" (a dialog would otherwise block the child forever);
// - keeps the last 64 KiB of stdout in memory and stderr in a capped file;
// - reports proc_start and proc_exit; keeps proc_exit until the broker acks it;
// - executes TERM/KILL for the broker; relaunches a dead broker from the tree's config, and kills
//   the child only if the broker stays away longer than the tree's broker-down window (G for
//   specs from before that window existed).

import { spawn } from "node:child_process";
import { openSync, readFileSync, statSync, writeSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { relaunchBroker } from "../client/launcher.ts";
import { decode, encode, PROTO } from "../protocol.ts";
import { childEnv, type KeeperSpec } from "../runtime.ts";

const spec = JSON.parse(readFileSync(process.argv[2], "utf8")) as KeeperSpec;
const STDERR_CAP = 256 * 1024;
const RING = 64 * 1024;

const stderrPath = join(spec.logDir, `${spec.id}.${spec.inc}.stderr.log`);
const stderrFd = openSync(stderrPath, "a");
const [cmd, ...args] = spec.argv;
const child = spawn(cmd, args, { cwd: spec.cwd, detached: true, stdio: ["pipe", "pipe", "pipe"], env: childEnv() });

let stdoutBuf = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (d: string) => {
	stdoutBuf += d;
	let i: number;
	while ((i = stdoutBuf.indexOf("\n")) >= 0) {
		const line = stdoutBuf.slice(0, i);
		stdoutBuf = stdoutBuf.slice(i + 1);
		if (!line.includes("extension_ui_request")) continue;
		try {
			const ev = JSON.parse(line);
			if (ev.type === "extension_ui_request" && ["confirm", "select", "input", "editor"].includes(ev.method)) {
				child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: ev.id, cancelled: true })}\n`);
			}
		} catch {
			// not JSON
		}
	}
	if (stdoutBuf.length > RING) stdoutBuf = "";
});
child.stderr.on("data", (d: Buffer) => {
	try {
		if (statSync(stderrPath).size < STDERR_CAP) writeSync(stderrFd, d);
	} catch {
		// ignore
	}
});
child.stdin.on("error", () => {});
// The child could not start at all (missing command or cwd): report it as an exit.
child.on("error", (err) => {
	writeSync(stderrFd, `keeper: ${err.message}\n`);
	if (!exitReport) {
		exitReport = { code: 127, signal: "start_failed" };
		sendFrame({ t: "proc_exit", ...exitReport });
	}
});

// ---------------------------------------------------------------- broker connection

let sock: Socket | undefined;
let exitReport: { code: number | null; signal: string | null } | undefined;
let exitAcked = false;
let brokerLostAt: number | undefined = undefined;
let buf = "";

const sendFrame = (f: object) => {
	if (sock && !sock.destroyed) sock.write(encode(f));
};

function connectBroker() {
	const s = connect(spec.socket);
	s.setEncoding("utf8");
	s.on("connect", () => {
		sock = s;
		if (brokerLostAt !== undefined) log(`broker back after ${Math.round((Date.now() - brokerLostAt) / 1000)} s`);
		brokerLostAt = undefined;
		relaunchDelay = RELAUNCH_FIRST_MS;
		lastWhy = undefined;
		sendFrame({ t: "keeper_hello", proto: PROTO, id: spec.id, inc: spec.inc, keeperPid: process.pid });
		if (child.pid) sendFrame({ t: "proc_start", pid: child.pid, pgid: child.pid });
		if (exitReport) sendFrame({ t: "proc_exit", ...exitReport });
	});
	s.on("data", (d: string) => {
		const { frames, rest } = decode(buf + d);
		buf = rest;
		for (const f of frames as Record<string, unknown>[]) {
			if (f.t === "signal" && child.pid && !exitReport) signal(f.sig === "KILL" ? "SIGKILL" : "SIGTERM");
			if (f.t === "shutdown") {
				// The tree is finished: make sure the child is gone, then leave.
				if (!exitReport) {
					signal("SIGKILL");
					child.once("exit", () => process.exit(0));
				} else process.exit(0);
			}
			if (f.t === "ack_exit") {
				exitAcked = true;
				finish();
			}
		}
	});
	s.on("error", () => {});
	s.on("close", () => {
		if (sock === s) sock = undefined;
		brokerLostAt ??= Date.now();
		setTimeout(connectBroker, 1000).unref();
	});
}

function signal(sig: NodeJS.Signals) {
	try {
		process.kill(-(child.pid as number), sig);
	} catch {
		try {
			child.kill(sig);
		} catch {
			// gone
		}
	}
}

child.on("exit", (code, sig) => {
	exitReport = { code, signal: sig };
	sendFrame({ t: "proc_exit", ...exitReport });
});

function finish() {
	if (!exitReport || !exitAcked) return;
	sock?.end();
	process.exit(0);
}

function log(msg: string) {
	console.log(`${new Date().toISOString()} keeper ${spec.id}.${spec.inc}: ${msg}`);
}

// ---------------------------------------------------------------- a broker that stays away
//
// Lost for RELAUNCH_FIRST_MS: relaunch it from the tree's config (lock-protected, so every Keeper
// and child may try), retrying with exponential backoff and jitter. The child keeps running for
// the tree's broker-down window; past it the link rule applies locally. A finished tree, or a
// broker that is back and has declared the child gone (signal, shutdown), ends it at once.

const RELAUNCH_FIRST_MS = 2000;
const RELAUNCH_MAX_MS = 60_000;
const windowMs = spec.treeDir ? (spec.brokerDownMs ?? spec.graceMs) : spec.graceMs;
let relaunchDelay = RELAUNCH_FIRST_MS;
let nextRelaunchAt = 0;
let relaunching = false;
let lastWhy: string | undefined;
let orphaned = false;

async function relaunch() {
	relaunching = true;
	try {
		await relaunchBroker(spec.treeDir!, spec.socket);
		log("relaunched the broker (or found it back)");
		nextRelaunchAt = Date.now() + RELAUNCH_FIRST_MS;
	} catch (err) {
		const why = (err as Error).message;
		if (/finished/.test(why)) {
			log(`${why}: ending the child`);
			return orphan();
		}
		if (why !== lastWhy) log(`broker relaunch failed: ${why}; keeping the child for up to ${Math.round(windowMs / 1000)} s of broker absence and retrying`);
		lastWhy = why;
		nextRelaunchAt = Date.now() + relaunchDelay * (0.5 + Math.random());
		relaunchDelay = Math.min(relaunchDelay * 2, RELAUNCH_MAX_MS);
	} finally {
		relaunching = false;
	}
}

function orphan() {
	if (!exitReport) {
		if (orphaned) return;
		orphaned = true;
		signal("SIGTERM");
		setTimeout(() => signal("SIGKILL"), 5000).unref();
	} else process.exit(0);
}

setInterval(() => {
	if (brokerLostAt === undefined) return;
	const lost = Date.now() - brokerLostAt;
	if (lost >= windowMs) {
		if (!orphaned) log(`broker unreachable for ${Math.round(lost / 1000)} s: ending the child (link rule)`);
		return orphan();
	}
	if (spec.treeDir && !relaunching && lost >= RELAUNCH_FIRST_MS && Date.now() >= nextRelaunchAt) void relaunch();
}, 1000);

// Heartbeat, so the broker does not drop this connection as dead (F14).
setInterval(() => sendFrame({ t: "hb" }), 15_000).unref();

// Keep the child's stdin open for its whole life: never end it here.
process.on("SIGTERM", () => signal("SIGTERM"));
connectBroker();
