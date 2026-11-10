// Paths, broker lock, runtime snapshot and node resolution (design D12, D13).
// Used by both the agent side (Launcher) and the broker; no pi or typebox imports.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, cpSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { homedir, tmpdir, uptime, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Limits } from "./protocol.ts";

export const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const SRC_ROOT = join(PKG_ROOT, "src");

/** Root of all per-user state: overridable for tests. */
export function stateRoot(): string {
	return process.env.PI_ACTORS_HOME ?? join(homedir(), ".pi", "agent", "actors");
}

export function treeDir(treeId: string): string {
	return join(stateRoot(), "trees", treeId);
}

/** Short socket path: macOS limits Unix socket paths to 104 bytes. */
export function socketPath(treeId: string): string {
	const base = process.env.PI_ACTORS_SOCKET_DIR ?? join(process.platform === "darwin" ? "/tmp" : tmpdir(), `pia-${userInfo().uid}`);
	const p = join(base, `${treeId}.sock`);
	if (Buffer.byteLength(p) > 103) throw new Error(`socket path too long (${Buffer.byteLength(p)} bytes): ${p}`);
	return p;
}

export function ensureDir(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * The socket directory lives in shared /tmp: it must be ours, a real directory, and private (F6).
 * Fails closed: another user could otherwise pre-create it and serve a fake broker.
 */
export function ensurePrivateDir(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const st = lstatSync(dir);
	if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} is not a plain directory; refusing to use it`);
	if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error(`${dir} belongs to uid ${st.uid}, not you; refusing to use it`);
	if ((st.mode & 0o077) !== 0) throw new Error(`${dir} is accessible to other users (mode ${(st.mode & 0o777).toString(8)}); refusing to use it`);
}

export interface Config {
	treeId: string;
	limits: Limits;
	/** Working directory for children that don't name one. */
	rootCwd: string;
	/** Command that starts pi: [executable, ...args]. */
	piCommand: string[];
	/** Snapshot directory every process of this tree runs from. */
	runtimeDir: string;
	/** Terminal multiplexer the root runs in (pane placement), and the root's pane there. */
	mux?: "herdr" | "tmux";
	rootPaneId?: string;
	/** Extra pi arguments for every child (tests use this to add a scripted provider). */
	childArgs?: string[];
	/** Test hook: replaces the child pi command entirely (fake agents). */
	childCommand?: string[];
}

/** Resolve a `node` binary: the running one if it is node, otherwise `node` on PATH. */
export function nodeBinary(): string {
	return /^node(\.exe)?$/i.test(basename(process.execPath)) ? process.execPath : "node";
}

/** Command that starts pi from inside a pi process (the running CLI), falling back to `pi`. */
export function piCommandFromProcess(): string[] {
	const script = process.argv[1];
	if (script && existsSync(script) && !script.startsWith("/$bunfs/")) return [process.execPath, script];
	return ["pi"];
}

/**
 * Copy src/ into a content-addressed snapshot outside node_modules, so Node strips types natively
 * and `pi update` cannot change a running tree's code (D12).
 */
export function ensureSnapshot(): string {
	const files = listFiles(SRC_ROOT).sort();
	const hash = createHash("sha256");
	for (const f of files) hash.update(f).update(readFileSync(join(SRC_ROOT, f)));
	const version = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")).version as string;
	const dir = join(stateRoot(), "runtime", `${version}-${hash.digest("hex").slice(0, 12)}`);
	if (!existsSync(join(dir, ".complete"))) {
		// Build aside, then rename into place: a crash or a concurrent copy never leaves a partial
		// snapshot marked complete.
		const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
		cpSync(SRC_ROOT, tmp, { recursive: true });
		writeFileAtomicSync(join(tmp, "package.json"), JSON.stringify({ type: "module", version }));
		writeFileAtomicSync(join(tmp, ".complete"), "");
		try {
			renameSync(tmp, dir);
		} catch {
			rmSync(tmp, { recursive: true, force: true }); // another process won the race
		}
	}
	return dir;
}

function listFiles(dir: string, prefix = ""): string[] {
	return readdirSync(dir).flatMap((f) => {
		const rel = join(prefix, f);
		return statSync(join(dir, f)).isDirectory() ? listFiles(join(dir, f), rel) : rel.endsWith(".ts") ? [rel] : [];
	});
}

/**
 * Replace a whole file so a reader sees the old or the new content, never a torn or empty one:
 * write a temp file in the same directory, fsync it, rename it over the target, fsync the
 * directory. On any failure (a full disk) the temp file is removed and the old file is untouched.
 */
export function writeFileAtomicSync(path: string, content: string, mode = 0o600): void {
	ensureDir(dirname(path));
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	try {
		const fd = openSync(tmp, "w", mode);
		try {
			const buf = Buffer.from(content);
			for (let off = 0; off < buf.length; ) {
				injectedFault(path, () => writeSync(fd, buf, off, Math.ceil((buf.length - off) / 2)));
				off += writeSync(fd, buf, off);
			}
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, path);
	} catch (err) {
		rmSync(tmp, { force: true });
		throw err;
	}
	// The rename itself must reach the disk, or a machine crash can bring back the old file.
	try {
		const dirFd = openSync(dirname(path), "r");
		try {
			fsyncSync(dirFd);
		} finally {
			closeSync(dirFd);
		}
	} catch {
		// the new content is in place; only its durability across a machine crash is unconfirmed
	}
}

/** Errors of the disk rather than of the program: a broker survives these and retries (ENOSPC, EIO...). */
export function isIoError(err: unknown): boolean {
	return ["ENOSPC", "EDQUOT", "EIO", "EROFS", "EFBIG", "EMFILE", "ENFILE"].includes((err as NodeJS.ErrnoException)?.code ?? "");
}

/**
 * Test hook: while the file named by PI_ACTORS_TEST_ENOSPC exists, state writes fail like on a
 * full disk, after writing part of their data (`partial`), as a real ENOSPC can.
 */
export function injectedFault(path: string, partial?: () => void): void {
	const flag = process.env.PI_ACTORS_TEST_ENOSPC;
	if (!flag || !existsSync(flag)) return;
	partial?.();
	throw Object.assign(new Error(`ENOSPC: no space left on device, write '${path}'`), { code: "ENOSPC", errno: -28, syscall: "write" });
}

// ---------------------------------------------------------------- tree config

/** A parsed config with the fields every process of the tree needs, or undefined. */
function parseConfig(text: string): Config | undefined {
	try {
		const c = JSON.parse(text) as Config;
		return c && typeof c === "object" && typeof c.treeId === "string" && typeof c.runtimeDir === "string" && Array.isArray(c.piCommand) && c.limits ? c : undefined;
	} catch {
		return undefined;
	}
}

export const configBackup = (configPath: string) => `${configPath}.bak`;

/**
 * Read a tree's config.json, falling back to its backup copy when it is missing, empty or
 * corrupt (a full disk truncated it once and every later launch failed). `problem` says what was
 * wrong with config.json; `config` is undefined only when the backup is unusable too.
 */
export function loadConfig(configPath: string): { config?: Config; text?: string; problem?: string; fromBackup?: boolean } {
	let problem: string | undefined;
	try {
		const text = readFileSync(configPath, "utf8");
		const config = parseConfig(text);
		if (config) return { config, text };
		problem = text.length === 0 ? `${configPath} is empty` : `${configPath} is not a valid tree config`;
	} catch (err) {
		problem = (err as NodeJS.ErrnoException).code === "ENOENT" ? `${configPath} is missing` : `${configPath} is unreadable: ${(err as Error).message}`;
	}
	try {
		const config = parseConfig(readFileSync(configBackup(configPath), "utf8"));
		if (config) return { config, problem, fromBackup: true };
	} catch {
		// no usable backup
	}
	return { problem };
}

/** Write config.json (and its backup) atomically, only where the content changed. */
export function saveConfig(configPath: string, config: Config, current?: string): void {
	const text = JSON.stringify(config, null, 1);
	if (text !== current) writeFileAtomicSync(configPath, text);
	let backup: string | undefined;
	try {
		backup = readFileSync(configBackup(configPath), "utf8");
	} catch {
		// none yet
	}
	if (backup !== text) writeFileAtomicSync(configBackup(configPath), text);
}

// ---------------------------------------------------------------- broker lock

export interface LockInfo {
	pid: number;
	bootTime: number;
}

export const bootTime = () => Math.round(Date.now() / 1000 - uptime());

export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Take the single-instance lock. The content is written to a private temp file and link()ed into
 * place, which is atomic: nobody ever sees an empty lock (F3). Replacing a stale lock (a dead pid,
 * or an earlier boot) is serialized by a short-lived takeover lock, so two contenders can never
 * both remove and replace it (N2). An unreadable lock is treated as live.
 */
export function acquireLock(dir: string): boolean {
	const path = join(dir, "broker.lock");
	const mine = JSON.stringify({ pid: process.pid, bootTime: bootTime() } satisfies LockInfo);
	const tmp = `${path}.${process.pid}.${Date.now()}`;
	writeFileSync(tmp, mine, { mode: 0o600 });
	try {
		// A lock that vanished between the two calls was just released: try once more.
		if (tryLink(tmp, path) || (!existsSync(path) && tryLink(tmp, path))) return true;
		if (!isStale(path)) return false;
		testPause(); // tests widen the judged-stale-then-replace window here
		// Only the holder of the takeover lock may replace a stale lock.
		const takeover = `${path}.takeover`;
		if (!tryLink(tmp, takeover)) {
			if (!oldFile(takeover, 10_000)) return false;
			rmSync(takeover, { force: true }); // its holder died mid-takeover
			if (!tryLink(tmp, takeover)) return false;
		}
		try {
			if (!isStale(path)) return false; // someone replaced it before we got the takeover lock
			rmSync(path, { force: true });
			return tryLink(tmp, path);
		} finally {
			rmSync(takeover, { force: true });
		}
	} finally {
		rmSync(tmp, { force: true });
	}
}

/** Test hook: PI_ACTORS_TEST_LOCK_PAUSE_MS widens race windows in the lock tests. */
function testPause() {
	const ms = Number(process.env.PI_ACTORS_TEST_LOCK_PAUSE_MS ?? 0);
	if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function tryLink(from: string, to: string): boolean {
	try {
		linkSync(from, to);
		return true;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw e;
	}
}

function isStale(path: string): boolean {
	let info: LockInfo | undefined;
	try {
		info = JSON.parse(readFileSync(path, "utf8"));
	} catch (e) {
		// Gone: not stale, just retry later. Unreadable or empty: its contents never reached the
		// disk before a machine crash (the lock is not fsynced); stale once it is old.
		return (e as NodeJS.ErrnoException).code !== "ENOENT" && oldFile(path, 10_000);
	}
	return !info || Math.abs(info.bootTime - bootTime()) > 5 || !pidAlive(info.pid);
}

function oldFile(path: string, ms: number): boolean {
	try {
		return Date.now() - statSync(path).mtimeMs > ms;
	} catch {
		return false;
	}
}

/** The broker re-checks that it still holds the lock; a broker that lost it must stop (N2). */
export function holdsLock(dir: string): boolean {
	try {
		return (JSON.parse(readFileSync(join(dir, "broker.lock"), "utf8")) as LockInfo).pid === process.pid;
	} catch {
		return false;
	}
}

export function releaseLock(dir: string): void {
	const path = join(dir, "broker.lock");
	try {
		const info = JSON.parse(readFileSync(path, "utf8")) as LockInfo;
		if (info.pid === process.pid) rmSync(path, { force: true });
	} catch {
		// already gone
	}
}

/** Child environment: everything except herdr's pane identity (operator N2) and our own vars. */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(env)) if (!k.startsWith("HERDR_") && !k.startsWith("PI_ACTORS_")) out[k] = v;
	// Test isolation hooks are kept.
	if (env.PI_ACTORS_HOME) out.PI_ACTORS_HOME = env.PI_ACTORS_HOME;
	if (env.PI_ACTORS_SOCKET_DIR) out.PI_ACTORS_SOCKET_DIR = env.PI_ACTORS_SOCKET_DIR;
	return out;
}

export interface KeeperSpec {
	id: string;
	inc: number;
	socket: string;
	/** Child command: [executable, ...args]. */
	argv: string[];
	cwd: string;
	logDir: string;
	/** How long the Keeper keeps a finished child's exit report while the broker is unreachable. */
	graceMs: number;
}

/** herdr agent names are global across herdr: prefix with the tree id. */
// herdr requires: lowercase letter first, then [a-z0-9_-], at most 32 characters.
/**
 * A herdr pane child that lost its tree closes its own pane as the process exits: the pane is a
 * shell that pi runs in, and the broker that would close it is gone. A no-op without a pane id.
 */
export function closeOwnPaneOnExit(paneId: unknown, run: (bin: string, args: string[]) => void = detachedRun): void {
	if (typeof paneId !== "string" || !paneId) return;
	process.once("exit", () => run(process.env.HERDR_BIN ?? "herdr", ["pane", "close", paneId]));
}

function detachedRun(bin: string, args: string[]) {
	try {
		spawn(bin, args, { detached: true, stdio: "ignore" }).unref();
	} catch {
		// best effort: the pane stays open
	}
}

export const paneAgentName = (treeId: string, id: string) =>
	`a${treeId.slice(-6)}-${id}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 32);

/**
 * Which multiplexer this process runs in, if any. The innermost wins: tmux sets TMUX only for its
 * own panes, while herdr's variables are also inherited by a tmux started inside herdr.
 */
export function detectMux(env: NodeJS.ProcessEnv = process.env): { mux: "herdr" | "tmux"; pane: string } | undefined {
	if (env.TMUX && env.TMUX_PANE) return { mux: "tmux", pane: env.TMUX_PANE };
	if (env.HERDR_ENV === "1" && env.HERDR_PANE_ID) return { mux: "herdr", pane: env.HERDR_PANE_ID };
	return undefined;
}
