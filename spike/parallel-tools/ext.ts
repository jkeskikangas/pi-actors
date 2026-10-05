import { Type } from "typebox";
import { installFaux, fauxAssistantMessage, fauxToolCall } from "../_lib/faux.ts";
// SPIKE_TOOLS="a,b" picks the two tools called in one assistant message.
const [A, B] = (process.env.SPIKE_TOOLS ?? "par,par").split(",");
export default function (pi: any) {
  installFaux(pi, ({ call }) => call === 0
    ? fauxAssistantMessage([fauxToolCall(A, { tag: "t1" }, { id: "c1" }), fauxToolCall(B, { tag: "t2" }, { id: "c2" })], { stopReason: "toolUse" })
    : fauxAssistantMessage("done"));
  const mk = (name: string, mode?: string) => pi.registerTool({ name, label: name, description: name,
    parameters: Type.Object({ tag: Type.String() }), ...(mode ? { executionMode: mode } : {}),
    async execute(id: string, p: any, _s: any, _u: any, ctx: any) {
      ctx.ui.notify(`START ${p.tag} ${name} ${Date.now()}`, "info");
      await new Promise((r) => setTimeout(r, 500));
      ctx.ui.notify(`END ${p.tag} ${name} ${Date.now()}`, "info");
      return { content: [{ type: "text", text: "ok" }], details: {} };
    } });
  mk("par"); mk("seq", "sequential");
  pi.on("message_end", (e: any, ctx: any) => { if (e.message.role === "toolResult") ctx.ui.notify(`RESULT_MSG ${e.message.toolCallId} ${Date.now()}`, "info"); });
}
