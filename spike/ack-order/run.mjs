import { startPi } from "../_lib/rpc.mjs";
import * as fs from "node:fs";
const dir = process.argv[2]; fs.mkdirSync(dir, { recursive: true });
for (const mode of [["--no-session"], ["--session-dir", dir]]) {
  const pi = startPi([...mode, "-e", new URL("./ext.ts", import.meta.url).pathname]);
  pi.send({ id: "1", type: "prompt", message: "go" });
  await pi.waitFor((e) => e.type === "agent_settled");
  await new Promise((r) => setTimeout(r, 300));
  console.log("mode", mode.join(" "));
  for (const e of pi.events) if (e.method === "notify") console.log("  ", e.message);
  pi.p.stdin.end(); await pi.exited;
}
