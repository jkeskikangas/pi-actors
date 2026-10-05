// Paths, broker lock, runtime snapshot and node resolution (design D12, D13).
// Used by both the agent side (Launcher) and the broker; no pi or typebox imports.

import { createHash } from "node:crypto";
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
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

export interface Config {
	treeId: string;
	limits: Limits;
	/** Working directory for children that don't name one. */
	rootCwd: string;
	/** Command that starts pi: [executable, ...args]. */
	piCommand: string[];
	/** Snapshot directory every process of this tree runs from. */
	runtimeDir: string;
	/** herdr pane of the root agent, for pane placement. */
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
		const tmp = `${dir}.tmp-${process.pid}`;
		rmSync(tmp, { recursive: true, force: true });
		cpSync(SRC_ROOT, tmp, { recursive: true });
		writeFileAtomicSync(join(tmp, "package.json"), JSON.stringify({ type: "module", version }));
		writeFileAtomicSync(join(tmp, ".complete"), "");
		try {
			cpSync(tmp, dir, { recursive: true });
		} finally {
			rmSync(tmp, { recursive: true, force: true });
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

function writeFileAtomicSync(path: string, content: string) {
	ensureDir(dirname(path));
	const fd = openSync(path, "w");
	writeSync(fd, content);
	closeSync(fd);
}

// ---------------------------------------------------------------- broker lock

export interface LockInfo {
	pid: number;
	bootTime: number;
}

export const bootTime = () => Math.round(Date.now() / 1000 - uptime());

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Take the single-instance lock (O_EXCL). A lock from an earlier boot or a dead pid is stale. */
export function acquireLock(dir: string): boolean {
	const path = join(dir, "broker.lock");
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(path, "wx", 0o600);
			writeSync(fd, JSON.stringify({ pid: process.pid, bootTime: bootTime() } satisfies LockInfo));
			closeSync(fd);
			return true;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
			let info: LockInfo | undefined;
			try {
				info = JSON.parse(readFileSync(path, "utf8"));
			} catch {
				info = undefined;
			}
			const stale = !info || Math.abs(info.bootTime - bootTime()) > 5 || !pidAlive(info.pid);
			if (!stale) return false;
			rmSync(path, { force: true });
		}
	}
	return false;
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
