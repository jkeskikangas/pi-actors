import { Type } from "typebox";
import * as fs from "node:fs";
import { installFaux, fauxAssistantMessage, fauxToolCall } from "../_lib/faux.ts";
const MARK = process.env.SPIKE_MARK!;
const mark = (s: string) => fs.appendFileSync(MARK, `${Date.now()} ${s}\n`);
export default function (pi: any) {
  // prompt "go" -> tool ping; prompt "long" -> tool slow (5s, honours signal)
  installFaux(pi, ({ context }) => {
    const msgs = context.messages; const last = msgs[msgs.length - 1];
    if (last.role === "user") { const txt = JSON.stringify(last.content); return fauxAssistantMessage(fauxToolCall(txt.includes("long") ? "slow" : "ping", {}), { stopReason: "toolUse" }); }
    return fauxAssistantMessage("done");
  });
  pi.registerTool({ name: "ping", label: "ping", description: "ping", parameters: Type.Object({}), async execute() { return { content: [{ type: "text", text: "pong" }], details: {} }; } });
  pi.registerTool({ name: "slow", label: "slow", description: "slow", parameters: Type.Object({}), async execute(_i: string, _p: any, signal: AbortSignal, _u: any, ctx: any) {
    mark("slow start");
    const how = process.env.SPIKE_HOW;
    if (how?.startsWith("busy")) setTimeout(() => { mark(`busy trigger ${how}`); if (how === "busy-shutdown") ctx.shutdown(); else { ctx.abort(); process.kill(process.pid, "SIGTERM"); } }, 300);
    await new Promise((r) => { const t = setTimeout(r, 5000); signal?.addEventListener("abort", () => { clearTimeout(t); r(undefined); }); });
    mark(`slow end aborted=${signal?.aborted}`);
    return { content: [{ type: "text", text: "slow done" }], details: {} };
  } });
  pi.registerCommand("spike-term", { description: "x", handler: async (how: string, ctx: any) => {
    setTimeout(() => { mark(`idle trigger ${how} isIdle=${ctx.isIdle()}`); if (how === "shutdown") ctx.shutdown(); else process.kill(process.pid, "SIGTERM"); }, 300);
  } });
  pi.on("session_shutdown", (e: any) => mark(`session_shutdown reason=${e.reason}`));
  process.on("exit", (c) => mark(`process exit code=${c}`));
}
