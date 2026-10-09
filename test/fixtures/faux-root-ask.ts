// Scripted root for the TUI check: spawn a child that asks its parent (this root), answer it,
// then show its report.
import { fauxAssistantMessage, fauxToolCall, installFaux } from "./faux.ts";

const textOf = (m: any): string =>
	typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((b: any) => b.text ?? "").join("") : "";

export default function (pi: any) {
	installFaux(pi, ({ call, context }) => {
		const all = (context.messages ?? []).map(textOf).join("\n");
		const last = textOf((context.messages ?? []).at(-1));
		if (last.includes("Report from asker") && last.includes("ANSWER RECEIVED")) return fauxAssistantMessage("ROOT GOT THE ANSWER");
		if (!all.includes("Started asker")) return fauxAssistantMessage(fauxToolCall("spawn", { task: "ask your parent", name: "asker" }, { id: `r${call}` }), { stopReason: "toolUse" });
		const question = /Message from asker \(msg ([^),]+)/.exec(last);
		if (question) return fauxAssistantMessage(fauxToolCall("send", { to: "asker", text: "REST", reply_to: question[1] }, { id: `r${call}` }), { stopReason: "toolUse" });
		return fauxAssistantMessage("waiting");
	});
}
