import { startPi } from "../_lib/rpc.mjs";
for (const tools of ["par,par", "seq,seq", "par,seq"]) {
  const pi = startPi(["--no-session", "-e", new URL("./ext.ts", import.meta.url).pathname], { env: { SPIKE_TOOLS: tools } });
  pi.send({ id: "1", type: "prompt", message: "go" });
  await pi.waitFor((e) => e.type === "agent_settled");
  const lines = pi.events.filter((e) => e.method === "notify").map((e) => e.message);
  const t0 = Math.min(...lines.map((l) => +l.split(" ").pop()));
  console.log(`tools=${tools}`); for (const l of lines) { const p = l.split(" "); console.log("   +" + (+p.pop() - t0) + "ms", p.join(" ")); }
  pi.p.stdin.end(); await pi.exited;
}
