// Headless placement: one detached Keeper per child (design D8). The Keeper owns the child's
// process and stdio, so the broker can crash and restart without the child noticing.

import { spawn } from "node:child_process";
import { openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nodeBinary } from "../runtime.ts";

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

/** Child environment: everything except herdr's pane identity (operator N2) and our own vars. */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(env)) if (!k.startsWith("HERDR_") && !k.startsWith("PI_ACTORS_")) out[k] = v;
	// Test isolation hooks are kept.
	if (env.PI_ACTORS_HOME) out.PI_ACTORS_HOME = env.PI_ACTORS_HOME;
	if (env.PI_ACTORS_SOCKET_DIR) out.PI_ACTORS_SOCKET_DIR = env.PI_ACTORS_SOCKET_DIR;
	return out;
}

/** Launch a Keeper for one child; returns the Keeper's pid. */
export function startHeadless(runtimeDir: string, spec: KeeperSpec): number {
	const specPath = join(spec.logDir, `${spec.id}.${spec.inc}.keeper.json`);
	writeFileSync(specPath, JSON.stringify(spec), { mode: 0o600 });
	const out = openSync(join(spec.logDir, `${spec.id}.${spec.inc}.keeper.log`), "a");
	const keeper = spawn(nodeBinary(), [join(runtimeDir, "keeper", "main.ts"), specPath], {
		cwd: spec.cwd,
		detached: true,
		stdio: ["ignore", out, out],
		env: childEnv(),
	});
	keeper.unref();
	return keeper.pid ?? -1;
}

/** Signal a child's process group directly (used when its Keeper is gone). */
export function signalGroup(pid: number, sig: "TERM" | "KILL"): void {
	try {
		process.kill(-pid, `SIG${sig}`);
	} catch {
		// already gone
	}
}
