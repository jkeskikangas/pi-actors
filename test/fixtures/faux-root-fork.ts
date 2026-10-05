// Scripted root for the fork test: fork a child that must see this conversation.
import { fauxAssistantMessage, fauxToolCall, installFaux } from "./faux.ts";

const textOf = (m: any): string =>
	typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((b: any) => b.text ?? "").join("") : "";

export default function (pi: any) {
	installFaux(pi, ({ call, context }) => {
		const all = (context.messages ?? []).map(textOf).join("\n");
		const last = textOf((context.messages ?? []).at(-1));
		if (last.includes("Report from forky")) return fauxAssistantMessage(`FORK DONE: ${last.includes("SECRET-42") ? "saw secret" : "no secret"}`);
		if (!all.includes("Started forky")) return fauxAssistantMessage(fauxToolCall("spawn", { task: "Repeat the secret word from our conversation.", name: "forky", fork: true, model: "faux/faux-2" }, { id: `c${call}` }), { stopReason: "toolUse" });
		return fauxAssistantMessage("waiting");
	});
}
