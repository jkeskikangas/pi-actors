import { Type } from "typebox";
import { installFaux, fauxAssistantMessage, fauxToolCall } from "../_lib/faux.ts";
export default function (pi: any) {
  installFaux(pi, ({ call }) => call === 0 ? fauxAssistantMessage(fauxToolCall("ask", {}, { id: "c1" }), { stopReason: "toolUse" }) : fauxAssistantMessage("done"));
  pi.registerTool({ name: "ask", label: "ask", description: "ask", parameters: Type.Object({}),
    async execute(_id: string, _p: any, signal: any, _u: any, ctx: any) {
      const opts = process.env.SPIKE_PASS_SIGNAL === "1" ? { signal } : undefined;
      const t = Date.now();
      const r = await ctx.ui.confirm("Spike?", "proceed?", opts);
      ctx.ui.notify(`CONFIRM_RESULT ${JSON.stringify(r)} after ${Date.now() - t}ms`, "info");
      return { content: [{ type: "text", text: String(r) }], details: {} };
    } });
}
