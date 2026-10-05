import { execFileSync } from "node:child_process";
import { installFaux, fauxAssistantMessage } from "../_lib/faux.ts";
export function make(label: string, withProvider: boolean) {
  return function (pi: any) {
    if (withProvider) installFaux(pi, () => fauxAssistantMessage("ok"));
    const register = label === "A" ? process.env.SPIKE_A_REGISTER !== "0" : process.env.SPIKE_B_REGISTER === "1";
    // Inert-copy detection without getFlag: read the process's own argv in the factory.
    const argvValue = (() => { const i = process.argv.findIndex((a) => a === "--actors-id" || a.startsWith("--actors-id=")); if (i < 0) return undefined; const a = process.argv[i]; return a.includes("=") ? a.split("=")[1] : process.argv[i + 1]; })();
    if (register) pi.registerFlag("actors-id", { type: "string", description: "spike" });
    const factoryValue = pi.getFlag("actors-id");
    let notified = false;
    pi.on("session_start", (e: any, ctx: any) => {
      ctx.ui.notify(`${label} session_start reason=${e.reason} factory=${JSON.stringify(factoryValue)} registered=${register} getFlag=${JSON.stringify(pi.getFlag("actors-id"))} argv=${JSON.stringify(argvValue)}`, "info");
      if (label === "A") {
        const child = execFileSync("sh", ["-c", 'echo "argv:$(ps -o args= -p $$)"; env | grep -i actors || echo "env:none"'], { encoding: "utf8" });
        ctx.ui.notify(`A subprocess: ${child.replace(/\n/g, " | ")} ; own argv has flag=${process.argv.some((a) => a.includes("actors-id"))}`, "info");
      }
    });
    if (label === "A") pi.registerCommand("spike-reload", { description: "reload", handler: async (_a: string, ctx: any) => { await ctx.reload(); } });
  };
}
