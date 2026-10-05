import { startPi, sleep } from "../_lib/rpc.mjs";
import * as fs from "node:fs"; import * as path from "node:path";
const EXT = new URL("./ext.ts", import.meta.url).pathname; const SCR = process.argv[2];
for (const how of ["shutdown", "sigterm", "busy-shutdown", "busy-abort-sigterm"]) {
  const dir = path.join(SCR, "term-" + how); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const MARK = path.join(dir, "marks.txt"); fs.writeFileSync(MARK, "");
  const pi = startPi(["--session-dir", dir, "-e", EXT], { env: { SPIKE_MARK: MARK, SPIKE_HOW: how } });
  const t0 = Date.now();
  pi.send({ id: "1", type: "prompt", message: "go" });
  await pi.waitFor((e) => e.type === "agent_settled");
  if (how.startsWith("busy")) pi.send({ id: "2", type: "prompt", message: "long" });
  else pi.send({ id: "2", type: "prompt", message: "/spike-term " + how });
  let ex = await Promise.race([pi.exited, sleep(3000).then(() => null)]);
  let note = "";
  if (!ex) { note = "NOT exited 3s after trigger; sending get_state"; pi.send({ id: "3", type: "get_state" }); ex = await Promise.race([pi.exited, sleep(3000).then(() => null)]); if (!ex) { note += "; still alive -> closing stdin"; pi.p.stdin.end(); ex = await pi.exited; } else note += " -> exited"; }
  const marks = fs.readFileSync(MARK, "utf8").trim().split("\n").map((l) => { const [t, ...r] = l.split(" "); return `+${+t - t0}ms ${r.join(" ")}`; });
  const sessFile = fs.readdirSync(dir, { recursive: true }).find((f) => String(f).endsWith(".jsonl"));
  const sess = sessFile ? fs.readFileSync(path.join(dir, String(sessFile)), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  const roles = sess.map((e) => e.type === "message" ? e.message.role : e.type).join(",");
  console.log(`== ${how}: exit=${JSON.stringify(ex)} ${note}\n   marks: ${marks.join(" | ")}\n   session entries: ${roles}\n   last stdout event: ${JSON.stringify(pi.events.at(-1)).slice(0, 120)}`);
}
