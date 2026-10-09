// Scripted root for the pane test: spawn a child in a herdr pane, wait for its report, stop it.
import { fauxAssistantMessage, fauxToolCall, installFaux } from "./faux.ts";

const textOf = (m: any): string =>
	typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((b: any) => b.text ?? "").join("") : "";

export default function (pi: any) {
	installFaux(pi, ({ call, context }) => {
		const all = (context.messages ?? []).map(textOf).join("\n");
		const last = textOf((context.messages ?? []).at(-1));
		const tool = (name: string, args: any) => fauxAssistantMessage(fauxToolCall(name, args, { id: `c${call}` }), { stopReason: "toolUse" });
		if (/^Stopping \S+\.$/.test(last)) return fauxAssistantMessage("PANE DONE"); // a stop it asked for sends no end notice
		if (last.includes("Report from panekid")) return tool("stop", { id: "panekid" });
		if (!all.includes("Started panekid")) return tool("spawn", { task: "Say hello", name: "panekid", pane: true });
		return fauxAssistantMessage("waiting");
	});
}
