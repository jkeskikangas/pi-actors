// Launcher: the root agent starts (or attaches to) its tree's broker (design D1, D12, D13).

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, openSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { DEFAULT_LIMITS, type Limits } from "../protocol.ts";
import { type Config, ensureDir, ensurePrivateDir, ensureSnapshot, loadConfig, nodeBinary, pidAlive, piCommandFromProcess, saveConfig, socketPath, stateRoot, treeDir, writeFileAtomicSync } from "../runtime.ts";

export interface LaunchOptions {
	treeId: string;
	rootCwd: string;
	limits?: Partial<Limits>;
	mux?: "herdr" | "tmux";
	rootPaneId?: string;
	childArgs?: string[];
	childCommand?: string[];
	piCommand?: string[];
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

function lockHeld(dir: string): boolean {
	try {
		const pid = (JSON.parse(readFileSync(join(dir, "broker.lock"), "utf8")) as { pid?: number }).pid;
		return typeof pid === "number" && pidAlive(pid);
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
		config = { ...loaded.config, rootCwd: opts.rootCwd, mux: opts.mux, rootPaneId: opts.rootPaneId, childArgs: opts.childArgs, childCommand: opts.childCommand };
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
	const out = openSync(logPath, "a");
	const broker = spawn(nodeBinary(), [join(config.runtimeDir, "broker", "main.ts"), dir, sock, configPath], {
		detached: true,
		stdio: ["ignore", out, out],
		cwd: dir,
	});
	broker.unref();
	// Another launcher may win the lock; either way a broker appears on the socket.
	for (let i = 0; i < 100; i++) {
		if (await canConnect(sock)) return sock;
		await new Promise((r) => setTimeout(r, 100));
	}
	const tail = logTail(logPath);
	throw new Error(`broker for tree ${opts.treeId} did not start${tail ? `: ${tail}` : ""}; see ${logPath}`);
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
