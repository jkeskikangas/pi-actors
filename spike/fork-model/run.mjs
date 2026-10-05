import { startPi } from "../_lib/rpc.mjs";
import * as fs from "node:fs"; import * as path from "node:path";
const EXT = new URL("./ext.ts", import.meta.url).pathname; const SCR = path.join(process.argv[2], "fork");
fs.rmSync(SCR, { recursive: true, force: true });
const cwdA = path.join(SCR, "cwdA"), cwdB = path.join(SCR, "cwdB"), sdirA = path.join(SCR, "sessA"), sdirB = path.join(SCR, "sessB");
for (const d of [cwdA, cwdB, sdirA, sdirB]) fs.mkdirSync(d, { recursive: true });
// 1. parent session in cwdA on faux-1
let pi = startPi(["--session-dir", sdirA, "-e", EXT], { cwd: cwdA });
pi.send({ id: "1", type: "prompt", message: "parent prompt" }); await pi.waitFor((e) => e.type === "agent_settled");
pi.p.stdin.end(); await pi.exited;
const parent = path.join(sdirA, fs.readdirSync(sdirA, { recursive: true }).find((f) => String(f).endsWith(".jsonl")));
console.log("parent header:", fs.readFileSync(parent, "utf8").split("\n")[0]);
// 2. fork from cwdB with another model (startPi passes --model faux/faux-1 first; the later --model wins?)
pi = startPi(["--session-dir", sdirB, "--fork", parent, "--model", "faux/faux-2", "-e", EXT], { cwd: cwdB });
const ss = await pi.waitFor((e) => e.method === "notify" && e.message.startsWith("session_start"));
console.log(ss.message);
pi.send({ id: "s", type: "get_state" }); const st = await pi.waitFor((e) => e.id === "s");
console.log("get_state model:", st.data.model.provider + "/" + st.data.model.id, "sessionFile:", st.data.sessionFile);
pi.send({ id: "2", type: "prompt", message: "child prompt" }); await pi.waitFor((e) => e.type === "agent_settled");
pi.p.stdin.end(); const ex = await pi.exited; console.log("exit", ex.code, pi.stderr.trim().slice(0, 200));
const child = path.join(sdirB, fs.readdirSync(sdirB, { recursive: true }).find((f) => String(f).endsWith(".jsonl")));
const lines = fs.readFileSync(child, "utf8").trim().split("\n").map((l) => JSON.parse(l));
console.log("child file:", child.replace(SCR, "<scr>"));
console.log("child header:", JSON.stringify(lines[0]));
console.log("child entries:", lines.slice(1).map((e) => e.type === "message" ? `${e.message.role}${e.message.role === "assistant" ? "(" + e.message.model + ")" : ""}` : e.type + (e.type === "model_change" ? "(" + e.modelId + ")" : "")).join(", "));
