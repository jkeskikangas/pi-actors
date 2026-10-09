// Scripted root agent for the live test: spawn → wait for report → ask a follow-up → stop.
import { fauxAssistantMessage, fauxToolCall, installFaux } from "./faux.ts";

const textOf = (m: any): string =>
	typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((b: any) => b.text ?? "").join("") : "";

export default function (pi: any) {
	installFaux(pi, ({ call, context }) => {
		const all = (context.messages ?? []).map(textOf).join("\n");
		const last = textOf((context.messages ?? []).at(-1));
		const tool = (name: string, args: any) => fauxAssistantMessage(fauxToolCall(name, args, { id: `c${call}` }), { stopReason: "toolUse" });
		if (/^Stopping \S+\.$/.test(last)) return fauxAssistantMessage("ALL DONE"); // a stop it asked for sends no end notice
		if (last.includes("Report from kid") && last.includes("ANSWER 4")) return tool("stop", { id: "kid" });
		if (last.includes("Report from kid") && last.includes("hello from kid")) return tool("send", { to: "kid", text: "what is 2+2?" });
		if (!all.includes("Started kid")) return tool("spawn", { task: "Say hello", name: "kid" });
		return fauxAssistantMessage("waiting");
	});
}
