// Launcher: the root agent starts (or attaches to) its tree's broker (design D1, D12, D13).

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, openSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { connect } from "node:net";
import { basename, dirname, join } from "node:path";
import { DEFAULT_LIMITS, type Limits } from "../protocol.ts";
import { bootTime, brokerDownMs, type Config, ensureDir, ensurePrivateDir, ensureSnapshot, loadConfig, nodeBinary, pidAlive, piCommandFromProcess, saveConfig, socketPath, stateRoot, treeDir, writeFileAtomicSync } from "../runtime.ts";

export interface LaunchOptions {
	treeId: string;
	rootCwd: string;
	limits?: Partial<Limits>;
	mux?: "herdr" | "tmux";
	rootPaneId?: string;
	childArgs?: string[];
	childCommand?: string[];
	piCommand?: string[];
	/** How long Keepers and children wait out a broker that cannot be relaunched (pi-actors.json). */
	brokerDownMs?: number;
}

/** The broker writes status.json; a finished tree is never restarted (F7). */
function treeFinished(dir: string): boolean {
	try {
		return JSON.parse(readFileSync(join(dir, "status.json"), "utf8")).finished === true;
	} catch {
		return false;
	}
}

export const DEFAULT_KEEP_FINISHED_DAYS = 7;

/**
 * Finished trees keep their event log and every child's session (the transcripts) for `keepMs`
 * after they finished, then lose all of it but a small `status.json`: that marker keeps a session
 * that recorded the tree id from restarting it as an empty tree (F7). Returns the pruned ids.
 */
export function pruneFinishedTrees(keepMs: number, now = Date.now()): string[] {
	const root = join(stateRoot(), "trees");
	let ids: string[];
	try {
		ids = readdirSync(root);
	} catch {
		return [];
	}
	const pruned: string[] = [];
	for (const id of ids) {
		const dir = join(root, id);
		const status = join(dir, "status.json");
		try {
			const st = JSON.parse(readFileSync(status, "utf8")) as { finished?: boolean; pruned?: string };
			if (st.finished !== true || st.pruned) continue;
			if (now - statSync(status).mtimeMs < keepMs) continue;
			if (lockHeld(dir)) continue; // a broker still shutting down
			for (const entry of readdirSync(dir)) if (entry !== "status.json") rmSync(join(dir, entry), { recursive: true, force: true });
			writeFileAtomicSync(status, JSON.stringify({ finished: true, pruned: new Date(now).toISOString() }));
			pruned.push(id);
		} catch {
			// unreadable or vanished: leave it
		}
	}
	return pruned;
}

function lockHeld(dir: string, thisBoot = false): boolean {
	try {
		const lock = JSON.parse(readFileSync(join(dir, "broker.lock"), "utf8")) as { pid?: number; bootTime?: number };
		// `thisBoot`: a pid from an earlier boot is someone else's now.
		return typeof lock.pid === "number" && pidAlive(lock.pid) && (!thisBoot || typeof lock.bootTime !== "number" || Math.abs(lock.bootTime - bootTime()) <= 5);
	} catch {
		return false;
	}
}

function canConnect(sock: string): Promise<boolean> {
	return new Promise((resolve) => {
		const s = connect(sock);
		s.once("connect", () => {
			s.destroy();
			resolve(true);
		});
		s.once("error", () => resolve(false));
	});
}

/**
 * Return the socket of a running broker for `treeId`, starting one if needed. The tree's config
 * (including its runtime snapshot) is written once and reused, so a restarted broker runs the
 * same code as the rest of the tree even after `pi update`.
 */
export async function ensureBroker(opts: LaunchOptions): Promise<string> {
	const dir = treeDir(opts.treeId);
	const sock = socketPath(opts.treeId);
	ensurePrivateDir(dirname(sock)); // never trust a listener in a directory someone else controls (F6)
	if (await canConnect(sock)) return sock;
	if (treeFinished(dir)) throw new Error(`tree ${opts.treeId} finished`);
	ensureDir(dir);
	const configPath = join(dir, "config.json");
	const logPath = join(dir, "broker.log");
	const notes: string[] = [];
	const loaded = existsSync(configPath) || existsSync(`${configPath}.bak`) ? loadConfig(configPath) : undefined;
	let config: Config;
	if (loaded?.config) {
		// The code snapshot stays pinned; where the root lives and how children start may change.
		config = { ...loaded.config, rootCwd: opts.rootCwd, mux: opts.mux, rootPaneId: opts.rootPaneId, childArgs: opts.childArgs, childCommand: opts.childCommand, brokerDownMs: opts.brokerDownMs ?? loaded.config.brokerDownMs };
		if (loaded.problem) notes.push(`${loaded.problem}; restored it from ${configPath}.bak`);
	}
	else {
		config = {
			treeId: opts.treeId,
			limits: { ...DEFAULT_LIMITS, ...opts.limits },
			rootCwd: opts.rootCwd,
			piCommand: opts.piCommand ?? piCommandFromProcess(),
			// A lost config of a running tree: its children name the snapshot they run from.
			runtimeDir: (loaded && runtimeOfChildren(dir)) || ensureSnapshot(),
			mux: opts.mux,
			rootPaneId: opts.rootPaneId,
			childArgs: opts.childArgs,
			childCommand: opts.childCommand,
			brokerDownMs: opts.brokerDownMs,
		};
		if (loaded) notes.push(`${loaded.problem} and has no usable backup; re-derived it (runtime ${config.runtimeDir})`);
	}
	try {
		// Atomic, and only when something changed: a full disk can no longer leave it empty.
		saveConfig(configPath, config, loaded?.fromBackup ? undefined : loaded?.text);
	} catch (err) {
		// No whole config anywhere (the broker falls back to the backup, as this launcher did).
		if (!loaded?.config) throw new Error(`pi-actors: cannot write ${configPath}: ${(err as Error).message}`);
		// The file on disk is still whole: start the broker from it.
		notes.push(`could not update ${configPath} (${(err as Error).message}); starting with the previous one`);
	}
	for (const n of notes) logLine(logPath, `launcher: ${n}`);
	await startAndWait(dir, sock, configPath, config);
	return sock;
}

/** Start a broker process (unless a live one holds the lock) and wait for its socket. */
async function startAndWait(dir: string, sock: string, configPath: string, config: Config): Promise<void> {
	const logPath = join(dir, "broker.log");
	// A live lock holder is a broker starting (or stuck): another process would only lose the lock.
	if (!lockHeld(dir, true)) {
		const out = openSync(logPath, "a");
		const broker = spawn(nodeBinary(), [join(config.runtimeDir, "broker", "main.ts"), dir, sock, configPath], {
			detached: true,
			stdio: ["ignore", out, out],
			cwd: dir,
		});
		broker.unref();
	}
	// Another launcher may win the lock; either way a broker appears on the socket.
	for (let i = 0; i < 100; i++) {
		if (await canConnect(sock)) return;
		await new Promise((r) => setTimeout(r, 100));
	}
	const tail = logTail(logPath);
	throw new Error(`broker for tree ${config.treeId} did not start${tail ? `: ${tail}` : ""}; see ${logPath}`);
}

/**
 * Relaunch the broker of a running tree from its saved config: what Keepers and children do when
 * their broker is gone (the root uses ensureBroker). Never creates a tree or writes its config;
 * throws "... finished" for a finished tree. Many callers may race: the broker lock picks one,
 * and a random pause first lets the others find its socket instead of starting more brokers.
 */
export async function relaunchBroker(dir: string, sock: string, jitterMs = 1000): Promise<void> {
	if (await canConnect(sock)) return;
	await new Promise((r) => setTimeout(r, Math.random() * jitterMs));
	if (await canConnect(sock)) return;
	if (treeFinished(dir)) throw new Error(`tree ${basename(dir)} finished`);
	const configPath = join(dir, "config.json");
	const { config, problem } = loadConfig(configPath);
	if (!config) throw new Error(`cannot relaunch the broker: ${problem} and has no usable backup`);
	await startAndWait(dir, sock, configPath, config);
}

/**
 * How a child stays linked to its tree: its connection relaunches a dead broker, and it gives up
 * (exits as an orphan) only after the tree's broker-down window, not after the 60 s grace.
 */
export function childLink(treeId: string, sock: string): { graceMs: number; redial: () => Promise<void> } {
	const dir = treeDir(treeId);
	return { graceMs: brokerDownMs(loadConfig(join(dir, "config.json")).config), redial: () => relaunchBroker(dir, sock) };
}

/** The runtime snapshot the tree's newest child was started from, if it still exists. */
function runtimeOfChildren(dir: string): string | undefined {
	let specs: { f: string; at: number }[];
	try {
		specs = readdirSync(join(dir, "agents")).filter((f) => f.endsWith(".keeper.json")).map((f) => ({ f: join(dir, "agents", f), at: statSync(join(dir, "agents", f)).mtimeMs }));
	} catch {
		return undefined;
	}
	for (const { f } of specs.sort((a, b) => b.at - a.at)) {
		try {
			const arg = (JSON.parse(readFileSync(f, "utf8")).argv as string[]).find((a) => a.startsWith("--actors-runtime="));
			const runtime = arg?.slice("--actors-runtime=".length);
			if (runtime && existsSync(join(runtime, ".complete"))) return runtime;
		} catch {
			// unreadable: try the next
		}
	}
	return undefined;
}

function logLine(path: string, line: string) {
	try {
		appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
	} catch {
		// a full disk: the caller's error carries it
	}
}

/** The broker's last words, for the caller's error message. */
function logTail(path: string): string {
	try {
		const text = readFileSync(path, "utf8").slice(-4096);
		const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("at "));
		return lines.slice(-3).join(" | ").slice(-600);
	} catch {
		return "";
	}
}
