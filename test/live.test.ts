// Live acceptance test: real pi 1.0.x in RPC mode, scripted provider (no model calls).
// Root spawns a child, receives its pushed report, sends a follow-up, receives the second
// report, stops the child and receives its end notice.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const home = mkdtempSync("/tmp/pia-live-");
after(() => {
	try {
		spawn("pkill", ["-f", home]);
	} catch {}
	if (!process.env.KEEP) setTimeout(() => rmSync(home, { recursive: true, force: true }), 500).unref();
});

const base = ["--mode", "rpc", "-ne", "-ns", "-np", "-nc", "--no-themes", "--offline"];


function runRoot(rootFixture: string, prompt: string, until: string) {
	const env = {
		...process.env,
		PI_ACTORS_HOME: join(home, "h"),
		PI_ACTORS_SOCKET_DIR: join(home, "s"),
		// --model keeps children on the scripted provider: never a real model call.
		PI_ACTORS_CHILD_ARGS: JSON.stringify([...base.slice(2), "-e", here("./fixtures/faux-kid.ts"), "--model", "faux/faux-1"]),
	};
	const pi = spawn("pi", [...base, "-e", process.env.PI_ACTORS_EXT ?? here("../src/index.ts"), "-e", here(rootFixture), "--model", "faux/faux-1", "--session-dir", join(home, "sessions")], { env, stdio: ["pipe", "pipe", "pipe"], cwd: home });
	let buf = "";
	let stderr = "";
	const texts: string[] = [];
	const done = new Promise<string[]>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timeout; messages: ${JSON.stringify(texts)}\nstderr: ${stderr.slice(-3000)}`)), 110_000);
		pi.stdout.on("data", (d) => {
			buf += d;
			let i: number;
			while ((i = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, i);
				buf = buf.slice(i + 1);
				let ev: any;
				try {
					ev = JSON.parse(line);
				} catch {
					continue;
				}
				if (ev.type !== "message_end") continue;
				const m = ev.message;
				const t = typeof m.content === "string" ? m.content : (m.content ?? []).map((b: any) => b.text ?? (b.type === "toolCall" ? `<${b.name}>` : "")).join("");
				texts.push(`${m.role}${m.customType ? `:${m.customType}` : ""}: ${t.slice(0, 300)}`);
				if (m.role === "assistant" && t.includes(until)) {
					clearTimeout(timer);
					pi.stdin.end();
					resolve(texts);
				}
			}
		});
	});
	pi.stderr.on("data", (d) => (stderr += d));
	pi.stdin.write(`${JSON.stringify({ id: "1", type: "prompt", message: prompt })}\n`);
	return done;
}

test("fork: the child inherits the parent's conversation and runs on another model", { timeout: 120_000 }, async () => {
	const texts = await runRoot("./fixtures/faux-root-fork.ts", "start SECRET-42", "FORK DONE");
	assert.ok(texts.some((t) => t.includes("FORK DONE: saw secret")), texts.join("\n"));
});

test("root ⇄ child round trip through real pi with push delivery", { timeout: 120_000 }, async () => {
	const env = {
		...process.env,
		PI_ACTORS_HOME: join(home, "h"),
		PI_ACTORS_SOCKET_DIR: join(home, "s"),
		PI_ACTORS_CHILD_ARGS: JSON.stringify([...base.slice(2), "-e", here("./fixtures/faux-kid.ts"), "--model", "faux/faux-1"]),
	};
	const pi = spawn("pi", [...base, "-e", here("../src/index.ts"), "-e", here("./fixtures/faux-root.ts"), "--model", "faux/faux-1", "--session-dir", join(home, "sessions")], { env, stdio: ["pipe", "pipe", "pipe"], cwd: home });
	let buf = "";
	let stderr = "";
	const texts: string[] = [];
	const done = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timeout; assistant texts: ${JSON.stringify(texts)}\nstderr: ${stderr.slice(-3000)}`)), 110_000);
		pi.stdout.on("data", (d) => {
			buf += d;
			let i: number;
			while ((i = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, i);
				buf = buf.slice(i + 1);
				let ev: any;
				try {
					ev = JSON.parse(line);
				} catch {
					continue;
				}
				if (ev.type === "message_end") {
					const m = ev.message;
					const t = typeof m.content === "string" ? m.content : (m.content ?? []).map((b: any) => b.text ?? (b.type === "toolCall" ? `<${b.name}>` : "")).join("");
					texts.push(`${m.role}${m.customType ? `:${m.customType}` : ""}: ${t.slice(0, 200)}`);
					if (m.role === "assistant" && t.includes("ALL DONE")) {
						clearTimeout(timer);
						resolve();
					}
				}
			}
		});
	});
	pi.stderr.on("data", (d) => (stderr += d));
	pi.stdin.write(`${JSON.stringify({ id: "1", type: "prompt", message: "start" })}\n`);
	await done;
	pi.stdin.end();
	const pushed = texts.filter((t) => t.startsWith("custom:pi-actors"));
	assert.ok(pushed.some((t) => t.includes("Report from kid") && t.includes("hello from kid")), texts.join("\n"));
	assert.ok(pushed.some((t) => t.includes("ANSWER 4")), texts.join("\n"));
	assert.ok(!pushed.some((t) => t.includes("kid ended")), `a stop the root asked for is not pushed back:\n${texts.join("\n")}`);
});

test("pane placement: an interactive child in a herdr pane reports and is stopped", { timeout: 180_000, skip: process.env.HERDR_ENV !== "1" ? "needs herdr" : false }, async () => {
	const texts = await runRoot("./fixtures/faux-root-pane.ts", "start", "PANE DONE");
	assert.ok(texts.some((t) => t.includes("Report from panekid") && t.includes("hello from kid")), texts.join("\n"));
	assert.ok(!texts.some((t) => t.includes("panekid ended")), texts.join("\n"));
});

const hasTmux = (() => {
	try {
		return spawnSync("tmux", ["-V"]).status === 0;
	} catch {
		return false;
	}
})();

test("tmux placement: a child in a tmux pane reports and its pane closes when stopped", { timeout: 120_000, skip: hasTmux ? false : "needs tmux" }, async () => {
	const sock = `pia-test-${process.pid}`;
	const t = (...args: string[]) => spawnSync("tmux", ["-L", sock, ...args], { encoding: "utf8" });
	const childArgs = JSON.stringify([...base.slice(2), "-e", here("./fixtures/faux-kid.ts"), "--model", "faux/faux-1"]);
	const root = ["pi", ...base.slice(2), "-e", here("../src/index.ts"), "-e", here("./fixtures/faux-root-pane.ts"), "--model", "faux/faux-1", "--session-dir", join(home, "tmux-sessions")];
	t("new-session", "-d", "-s", "t", "-x", "220", "-y", "50", "-c", home, "-e", `PI_ACTORS_HOME=${join(home, "th")}`, "-e", `PI_ACTORS_SOCKET_DIR=${join(home, "ts")}`, "-e", `PI_ACTORS_CHILD_ARGS=${childArgs}`, "--", ...root);
	try {
		const screen = () => t("capture-pane", "-p", "-t", "t").stdout;
		const waitFor = async (pred: () => boolean, what: string, ms = 60_000) => {
			const end = Date.now() + ms;
			while (!pred()) {
				if (Date.now() > end) throw new Error(`timeout waiting for ${what}:\n${screen()}`);
				await new Promise((r) => setTimeout(r, 300));
			}
		};
		await waitFor(() => /faux-1/.test(screen()), "the root TUI");
		t("send-keys", "-t", "t", "start", "Enter");
		await waitFor(() => t("list-panes", "-t", "t", "-F", "#{pane_id}").stdout.trim().split("\n").length === 2, "the child's pane");
		await waitFor(() => /PANE DONE/.test(screen()), "the report and the stop");
		await waitFor(() => t("list-panes", "-t", "t", "-F", "#{pane_id}").stdout.trim().split("\n").length === 1, "the child's pane to close");
	} finally {
		t("kill-server");
	}
});
