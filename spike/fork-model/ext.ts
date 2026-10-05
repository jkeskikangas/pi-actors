import { installFaux, fauxAssistantMessage } from "../_lib/faux.ts";
export default function (pi: any) {
  installFaux(pi, ({ context }) => fauxAssistantMessage(`reply #${context.messages.filter((m: any) => m.role === "user").length}`));
  pi.on("session_start", (e: any, ctx: any) => ctx.ui.notify(`session_start reason=${e.reason} cwd=${ctx.cwd} file=${ctx.sessionManager.getSessionFile()} entries=${ctx.sessionManager.getEntries().length} model=${ctx.model?.provider}/${ctx.model?.id}`, "info"));
}
