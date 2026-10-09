// Pane placement: the child runs as an interactive pi in a herdr pane (design, Integration).
// Identity is passed as pi flags after `--`, never through the pane's shell environment.

import { execFile } from "node:child_process";
import { paneAgentName } from "../runtime.ts";

export { paneAgentName };

export interface PaneHandle {
	paneId: string;
}

function herdr(args: string[], timeoutMs = 60_000): Promise<unknown> {
	return new Promise((resolve, reject) => {
		execFile(process.env.HERDR_BIN ?? "herdr", args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
			if (err) return reject(new Error(`herdr ${args.slice(0, 2).join(" ")}: ${err.message}`));
			try {
				const out = JSON.parse(stdout);
				if (out?.error) return reject(new Error(`herdr ${args.slice(0, 2).join(" ")}: ${out.error.message ?? out.error.code}`));
				resolve(out?.result);
			} catch {
				resolve(undefined);
			}
		});
	});
}

export async function herdrAvailable(rootPaneId: string | undefined): Promise<boolean> {
	if (!rootPaneId) return false;
	try {
		await herdr(["pane", "get", rootPaneId], 5000);
		return true;
	} catch {
		return false;
	}
}

/** Split a pane next to the root's and start pi in it with the given pi arguments. */
export async function startPane(rootPaneId: string, name: string, cwd: string, piArgs: string[]): Promise<PaneHandle> {
	const split = (await herdr(["pane", "split", rootPaneId, "--direction", "right", "--cwd", cwd, "--no-focus"])) as { pane?: { pane_id?: string } };
	const paneId = split?.pane?.pane_id;
	if (!paneId) throw new Error("herdr pane split returned no pane id");
	try {
		// The child learns its own pane: if it loses its tree it closes the pane itself (a herdr pane
		// is a shell that outlives pi). Explicit, rather than read from the environment: the broker
		// strips herdr's pane identity from children (N2).
		await herdr(["agent", "start", name, "--kind", "pi", "--pane", paneId, "--timeout", "120000", "--", ...piArgs, `--actors-pane=${paneId}`], 130_000);
	} catch (err) {
		await closePane(paneId);
		throw err;
	}
	return { paneId };
}

/** The pane's foreground process group: the identity check for pane children (D11). */
export async function paneForegroundGroup(paneId: string): Promise<number | undefined> {
	try {
		const info = (await herdr(["pane", "process-info", "--pane", paneId], 5000)) as { process_info?: { foreground_process_group_id?: number } };
		return info?.process_info?.foreground_process_group_id;
	} catch {
		return undefined;
	}
}

export async function listPanes(): Promise<Set<string> | undefined> {
	try {
		const out = (await herdr(["pane", "list"], 10_000)) as { panes?: { pane_id: string }[] };
		return new Set((out?.panes ?? []).map((p) => p.pane_id));
	} catch {
		return undefined;
	}
}

export async function closePane(paneId: string): Promise<void> {
	await herdr(["pane", "close", paneId], 10_000).catch(() => {});
}
