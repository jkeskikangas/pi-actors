// tmux placement: the child runs as an interactive pi in a tmux pane. pi is the pane's own
// command (argv passed through, no shell), so #{pane_pid} is pi's pid: the identity check.

import { execFile } from "node:child_process";

function tmux(args: string[], timeoutMs = 30_000): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(process.env.TMUX_BIN ?? "tmux", args, { timeout: timeoutMs }, (err, stdout) => {
			if (err) return reject(new Error(`tmux ${args[0]}: ${err.message}`));
			resolve(stdout.trim());
		});
	});
}

export async function tmuxAvailable(rootPane: string | undefined): Promise<boolean> {
	if (!rootPane) return false;
	try {
		await tmux(["display-message", "-p", "-t", rootPane, "#{pane_id}"], 5000);
		return true;
	} catch {
		return false;
	}
}

/** Split next to the root's pane and run pi there; env carries test/runtime overrides. */
export async function startTmuxPane(rootPane: string, cwd: string, argv: string[], env: Record<string, string>): Promise<string> {
	const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
	const pane = await tmux(["split-window", "-d", "-h", "-t", rootPane, "-c", cwd, ...envArgs, "-P", "-F", "#{pane_id}", "--", ...argv]);
	if (!/^%\d+$/.test(pane)) throw new Error(`tmux split-window returned ${JSON.stringify(pane)}`);
	return pane;
}

/** The pane's process: pi itself, since it is the pane command. */
export async function tmuxPanePid(paneId: string): Promise<number | undefined> {
	try {
		const pid = Number(await tmux(["display-message", "-p", "-t", paneId, "#{pane_pid}"], 5000));
		return Number.isFinite(pid) && pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

export async function listTmuxPanes(): Promise<Set<string> | undefined> {
	try {
		return new Set((await tmux(["list-panes", "-a", "-F", "#{pane_id}"], 10_000)).split("\n").filter(Boolean));
	} catch {
		return undefined;
	}
}

export async function closeTmuxPane(paneId: string): Promise<void> {
	await tmux(["kill-pane", "-t", paneId], 10_000).catch(() => {});
}
