import { Type } from "typebox";
import * as fs from "node:fs";
import { installFaux, fauxAssistantMessage, fauxToolCall } from "../_lib/faux.ts";
const ID = "call-ack-1";
export default function (pi: any) {
  installFaux(pi, ({ call }) => call === 0 ? fauxAssistantMessage(fauxToolCall("ping", {}, { id: ID }), { stopReason: "toolUse" }) : fauxAssistantMessage("done"));
  pi.registerTool({ name: "ping", label: "ping", description: "ping", parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: "pong" }], details: {} }; } });
  const probe = (ev: string, ctx: any, extra = "") => {
    const entries = ctx.sessionManager.getEntries();
    const inMem = entries.some((e: any) => e.type === "message" && e.message?.role === "toolResult" && e.message.toolCallId === ID);
    const file = ctx.sessionManager.getSessionFile?.();
    let onDisk: any = "n/a";
    if (file) { try { onDisk = fs.readFileSync(file, "utf8").includes(`"toolCallId":"${ID}"`) && fs.readFileSync(file, "utf8").includes('"role":"toolResult"'); } catch { onDisk = "nofile"; } }
    ctx.ui.notify(`PROBE ${ev}${extra} inMemory=${inMem} onDisk=${onDisk}`, "info");
  };
  pi.on("tool_execution_end", (e: any, ctx: any) => probe("tool_execution_end", ctx));
  pi.on("tool_result", (e: any, ctx: any) => probe("tool_result", ctx));
  pi.on("message_end", (e: any, ctx: any) => { if (e.message.role === "toolResult") probe("message_end(toolResult)", ctx); });
  pi.on("turn_end", (e: any, ctx: any) => probe("turn_end", ctx, `(turn ${e.turnIndex})`));
  pi.on("agent_end", (e: any, ctx: any) => probe("agent_end", ctx));
  pi.on("agent_before_settle", (e: any, ctx: any) => probe("agent_before_settle", ctx));
  pi.on("agent_settled", (e: any, ctx: any) => probe("agent_settled", ctx));
}
