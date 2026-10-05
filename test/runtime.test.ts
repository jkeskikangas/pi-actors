import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { detectMux, ensurePrivateDir } from "../src/runtime.ts";

const tmp = mkdtempSync("/tmp/pia-rt-");
after(() => rmSync(tmp, { recursive: true, force: true }));
const runtime = fileURLToPath(new URL("../src/runtime.ts", import.meta.url));

test("F6: the socket directory must be ours, private and not a symlink", () => {
	const ok = join(tmp, "ok");
	ensurePrivateDir(ok);
	const open = join(tmp, "open");
	mkdirSync(open);
	chmodSync(open, 0o777);
	assert.throws(() => ensurePrivateDir(open), /accessible to other users/);
	const link = join(tmp, "link");
	symlinkSync(ok, link);
	assert.throws(() => ensurePrivateDir(link), /not a plain directory/);
});

test("F3: of many processes racing for the broker lock, exactly one wins", async () => {
	for (let round = 0; round < 5; round++) {
		const dir = join(tmp, `race${round}`);
		mkdirSync(dir);
		const file = join(tmp, `race${round}.mjs`);
		writeFileSync(file, `import { acquireLock } from ${JSON.stringify(pathToFileURL(runtime).href)};
const start = Number(process.argv[2]); while (Date.now() < start) {}
console.log(acquireLock(${JSON.stringify(dir)}) ? "WON" : "lost");
setTimeout(() => {}, 1000);`);
		const start = Date.now() + 1500;
		const outs = await Promise.all(Array.from({ length: 10 }, () => new Promise<string>((resolve) => {
			const p = spawn(process.execPath, [file, String(start)]);
			let out = "";
			p.stdout.on("data", (d) => (out += d));
			p.stderr.on("data", (d) => (out += d));
			p.on("close", () => resolve(out));
		})));
		assert.equal(outs.filter((o) => o.includes("WON")).length, 1, outs.join("|"));
	}
});

test("the innermost multiplexer wins: tmux inside herdr places panes in tmux", () => {
	assert.deepEqual(detectMux({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2", TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%3" }), { mux: "tmux", pane: "%3" });
	assert.deepEqual(detectMux({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2" }), { mux: "herdr", pane: "w1:p2" });
	assert.equal(detectMux({}), undefined);
});
