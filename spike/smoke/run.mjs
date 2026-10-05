import { startPi } from "../_lib/rpc.mjs";
const pi = startPi(["--no-session", "-e", new URL("./ext.ts", import.meta.url).pathname], { log: true });
pi.send({ id: "1", type: "prompt", message: "hi" });
await pi.waitFor((e) => e.type === "agent_settled");
pi.p.stdin.end(); console.log(await pi.exited);
