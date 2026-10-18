// Scripted root for the live test: spawns three kids, then stays busy with tool turns while
// their reports arrive; they must reach it batched, in the same run, after its last busy turn.
import { fauxAssistantMessage, fauxToolCall, installFaux } from "./faux.ts";

const textOf = (m: any): string =>
	typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((b: any) => b.text ?? "").join("") : "";

export default function (pi: any) {
	installFaux(pi, ({ call, context }) => {
		const msgs = context.messages ?? [];
		const all = msgs.map(textOf).join("\n");
		const tool = (name: string, args: any) => fauxAssistantMessage(fauxToolCall(name, args, { id: `c${call}` }), { stopReason: "toolUse" });
		const reports = (all.match(/Report from k\d/g) ?? []).length;
		if (reports >= 3) return fauxAssistantMessage(`ALL REPORTS ${reports}`);
		// One kid per busy turn, so their reports arrive at different times.
		const started = (all.match(/Started k\d/g) ?? []).length;
		const slept = (all.match(/SLEPT/g) ?? []).length;
		if (started < 3 && slept >= started) return tool("spawn", { task: "Say hello", name: `k${started + 1}` });
		if (slept < 4) return tool("bash", { command: "sleep 1; echo SLEPT" });
		return fauxAssistantMessage("BUSY DONE");
	});
}
