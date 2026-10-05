// Headless placement: one detached Keeper per child (design D8). The Keeper owns the child's
// process and stdio, so the broker can crash and restart without the child noticing.

import { spawn } from "node:child_process";
import { openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { childEnv, type KeeperSpec, nodeBinary } from "../runtime.ts";


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
