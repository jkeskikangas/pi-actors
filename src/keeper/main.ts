// Keeper: OS parent of one headless child (design D8).
// - starts the child detached in its own process group, with no shell;
// - holds the child's stdin open (RPC pi exits when stdin closes) and answers extension dialogs
//   with "cancelled" (a dialog would otherwise block the child forever);
// - keeps the last 64 KiB of stdout in memory and stderr in a capped file;
// - reports proc_start and proc_exit; keeps proc_exit until the broker acks it;
// - executes TERM/KILL for the broker; kills the child if the broker stays away longer than G.

import { spawn } from "node:child_process";
import { openSync, readFileSync, statSync, writeSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
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
		brokerLostAt = undefined;
		sendFrame({ t: "keeper_hello", proto: PROTO, id: spec.id, inc: spec.inc, keeperPid: process.pid });
		if (child.pid) sendFrame({ t: "proc_start", pid: child.pid, pgid: child.pid });
		if (exitReport) sendFrame({ t: "proc_exit", ...exitReport });
	});
	s.on("data", (d: string) => {
		const { frames, rest } = decode(buf + d);
		buf = rest;
		for (const f of frames as Record<string, unknown>[]) {
			if (f.t === "signal" && child.pid) signal(f.sig === "KILL" ? "SIGKILL" : "SIGTERM");
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

// The broker gone for longer than G: the link rule applies locally.
setInterval(() => {
	if (brokerLostAt === undefined || Date.now() - brokerLostAt < spec.graceMs) return;
	if (!exitReport) {
		signal("SIGTERM");
		setTimeout(() => signal("SIGKILL"), 5000).unref();
	} else process.exit(0);
}, 1000);

// Heartbeat, so the broker does not drop this connection as dead (F14).
setInterval(() => sendFrame({ t: "hb" }), 15_000).unref();

// Keep the child's stdin open for its whole life: never end it here.
process.on("SIGTERM", () => signal("SIGTERM"));
connectBroker();
