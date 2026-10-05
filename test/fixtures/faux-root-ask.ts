// Scripted root for the TUI check: spawn a child that asks the human, then show its report.
import { fauxAssistantMessage, fauxToolCall, installFaux } from "./faux.ts";

const textOf = (m: any): string =>
	typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((b: any) => b.text ?? "").join("") : "";

export default function (pi: any) {
	installFaux(pi, ({ call, context }) => {
		const all = (context.messages ?? []).map(textOf).join("\n");
		const last = textOf((context.messages ?? []).at(-1));
		if (last.includes("Report from asker") && last.includes("ANSWER RECEIVED")) return fauxAssistantMessage("ROOT GOT THE ANSWER");
		if (!all.includes("Started asker")) return fauxAssistantMessage(fauxToolCall("spawn", { task: "ask the human", name: "asker" }, { id: `r${call}` }), { stopReason: "toolUse" });
		return fauxAssistantMessage("waiting");
	});
}
