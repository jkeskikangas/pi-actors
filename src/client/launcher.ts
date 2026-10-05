// Launcher: the root agent starts (or attaches to) its tree's broker (design D1, D12, D13).

import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { DEFAULT_LIMITS, type Limits } from "../protocol.ts";
import { type Config, ensureDir, ensurePrivateDir, ensureSnapshot, nodeBinary, piCommandFromProcess, socketPath, treeDir } from "../runtime.ts";

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
	let config: Config;
	if (existsSync(configPath)) {
		// The code snapshot stays pinned; where the root lives and how children start may change.
		config = { ...JSON.parse(readFileSync(configPath, "utf8")), rootCwd: opts.rootCwd, mux: opts.mux, rootPaneId: opts.rootPaneId, childArgs: opts.childArgs, childCommand: opts.childCommand };
		writeFileSync(configPath, JSON.stringify(config, null, 1), { mode: 0o600 });
	}
	else {
		config = {
			treeId: opts.treeId,
			limits: { ...DEFAULT_LIMITS, ...opts.limits },
			rootCwd: opts.rootCwd,
			piCommand: opts.piCommand ?? piCommandFromProcess(),
			runtimeDir: ensureSnapshot(),
			mux: opts.mux,
			rootPaneId: opts.rootPaneId,
			childArgs: opts.childArgs,
			childCommand: opts.childCommand,
		};
		writeFileSync(configPath, JSON.stringify(config, null, 1), { mode: 0o600 });
	}
	const out = openSync(join(dir, "broker.log"), "a");
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
	throw new Error(`broker for tree ${opts.treeId} did not start; see ${join(dir, "broker.log")}`);
}
