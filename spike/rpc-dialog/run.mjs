import { startPi, sleep } from "../_lib/rpc.mjs";
const EXT = new URL("./ext.ts", import.meta.url).pathname;
const cases = [
  ["reply cancelled:true", (pi, req) => pi.send({ type: "extension_ui_response", id: req.id, cancelled: true })],
  ["reply confirmed:true", (pi, req) => pi.send({ type: "extension_ui_response", id: req.id, confirmed: true })],
  ["reply confirmed:false", (pi, req) => pi.send({ type: "extension_ui_response", id: req.id, confirmed: false })],
  ["reply {} (no fields)", (pi, req) => pi.send({ type: "extension_ui_response", id: req.id })],
  ["rpc abort command, no reply", (pi) => pi.send({ id: "a", type: "abort" })],
  ["rpc abort, confirm got {signal}", (pi) => pi.send({ id: "a", type: "abort" }), { SPIKE_PASS_SIGNAL: "1" }],
  ["close stdin while dialog pending", (pi) => pi.p.stdin.end()],
];
for (const [name, act, env] of cases) {
  const pi = startPi(["--no-session", "-e", EXT], { env });
  pi.send({ id: "1", type: "prompt", message: "go" });
  const req = await pi.waitFor((e) => e.type === "extension_ui_request" && e.method === "confirm");
  await sleep(1500);
  const blocked = !pi.events.some((e) => e.type === "tool_execution_end");
  act(pi, req);
  let res;
  try { res = await pi.waitFor((e) => e.method === "notify" && e.message.startsWith("CONFIRM_RESULT"), 4000); } catch { res = { message: "NO RESULT within 4s" }; }
  const settled = await pi.waitFor((e) => e.type === "agent_settled", 3000).then(() => true, () => false);
  if (!pi.p.stdin.writableEnded) pi.p.stdin.end();
  const ex = await Promise.race([pi.exited, sleep(5000).then(() => { pi.p.kill("SIGKILL"); return "hung->SIGKILLed"; })]);
  console.log(`== ${name}\n   request: ${JSON.stringify({ type: req.type, method: req.method, id: req.id.slice(0, 8) + "…", title: req.title, message: req.message, timeout: req.timeout })}\n   blocked 1.5s before reply: ${blocked}\n   ${res.message}\n   agent_settled: ${settled}; exit: ${JSON.stringify(ex)}`);
}
