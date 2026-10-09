// Scripted root for the orphaned-pane test: spawn a child in a herdr pane and leave it running.
import { fauxAssistantMessage, fauxToolCall, installFaux } from "./faux.ts";

const textOf = (m: any): string =>
	typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((b: any) => b.text ?? "").join("") : "";

export default function (pi: any) {
	installFaux(pi, ({ call, context }) => {
		const all = (context.messages ?? []).map(textOf).join("\n");
		const last = textOf((context.messages ?? []).at(-1));
		if (last.includes("Report from orphan")) return fauxAssistantMessage("ORPHAN READY");
		if (!all.includes("Started orphan")) return fauxAssistantMessage(fauxToolCall("spawn", { task: "Say hello", name: "orphan", pane: true, cwd: "orphan" }, { id: `c${call}` }), { stopReason: "toolUse" });
		return fauxAssistantMessage("waiting");
	});
}
