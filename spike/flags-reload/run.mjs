import { startPi } from "../_lib/rpc.mjs";
const A = new URL("./extA.ts", import.meta.url).pathname, B = new URL("./extB.ts", import.meta.url).pathname;
const show = (pi, from = 0) => pi.events.slice(from).filter((e) => e.method === "notify" || e.type === "extension_error" || (e.type === "response" && !e.success)).forEach((e) => console.log("   ", e.message ?? JSON.stringify(e)));
const cases = [
  ["both register (dup flag)", ["--actors-id", "X1"], { SPIKE_B_REGISTER: "1" }],
  ["only A registers, space form", ["--actors-id", "X1"], {}],
  ["only A registers, eq form", ["--actors-id=X2"], {}],
  ["value starting with dash", ["--actors-id", "-neg"], {}],
  ["value starting with dash, eq form", ["--actors-id=-neg"], {}],
  ["nobody registers (unknown flag)", ["--actors-id", "X3"], { SPIKE_A_REGISTER: "0" }],
];
for (const [name, args, env] of cases) {
  console.log(`== ${name}: pi ${args.join(" ")} -e extA -e extB ${JSON.stringify(env)}`);
  const pi = startPi(["--no-session", ...args, "-e", A, "-e", B], { env });
  try {
    await pi.waitFor((e) => e.method === "notify" && e.message.startsWith("B session_start"), 8000);
    show(pi); const n = pi.events.length;
    pi.send({ id: "r", type: "prompt", message: "/spike-reload" });
    await pi.waitFor((e) => e.method === "notify" && e.message.startsWith("B session_start reason=reload"), 8000);
    console.log("  after /spike-reload (rpc prompt -> extension command -> ctx.reload()):"); show(pi, n);
  } catch (err) { console.log("   no session_start (see stderr)"); }
  pi.p.stdin.end(); const ex = await pi.exited; console.log("   exit", ex.code, "stderr:", pi.stderr.trim().slice(0, 300));
}
