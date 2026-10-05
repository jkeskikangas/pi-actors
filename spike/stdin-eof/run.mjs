// Reuses ../rpc-terminate/ext.ts (SPIKE_HOW=none: no self-termination).
import { startPi, sleep } from "../_lib/rpc.mjs";
import * as fs from "node:fs"; import * as path from "node:path";
const EXT = new URL("../rpc-terminate/ext.ts", import.meta.url).pathname; const SCR = process.argv[2];
for (const state of ["idle", "busy (5s tool running)", "never prompted"]) {
  const dir = path.join(SCR, "eof-" + state.split(" ")[0] + (state.startsWith("never") ? "-np" : "")); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const MARK = path.join(dir, "marks.txt"); fs.writeFileSync(MARK, "");
  const pi = startPi(["--session-dir", dir, "-e", EXT], { env: { SPIKE_MARK: MARK, SPIKE_HOW: "none" } });
  if (state.startsWith("never")) await sleep(1000);
  else { pi.send({ id: "1", type: "prompt", message: "go" }); await pi.waitFor((e) => e.type === "agent_settled"); }
  if (state.startsWith("busy")) { pi.send({ id: "2", type: "prompt", message: "long" }); await pi.waitFor((e) => e.type === "tool_execution_start" && e.toolName === "slow"); await sleep(200); }
  const t = Date.now(); pi.p.stdin.end();
  const ex = await Promise.race([pi.exited, sleep(10000).then(() => null)]);
  const dt = Date.now() - t; if (!ex) pi.p.kill("SIGKILL");
  console.log(`== ${state}: exit=${JSON.stringify(ex && { code: ex.code, sig: ex.sig })} ${dt}ms after stdin close\n   marks: ${fs.readFileSync(MARK, "utf8").trim().split("\n").map((l) => l.split(" ").slice(1).join(" ")).join(" | ")}`);
}
