// Scripted child agent for the live test: final answers become reports.
import { fauxAssistantMessage, installFaux } from "./faux.ts";

const textOf = (m: any): string =>
	typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((b: any) => b.text ?? "").join("") : "";

export default function (pi: any) {
	installFaux(pi, ({ context }) => {
		const msgs = context.messages ?? [];
		const last = textOf(msgs.at(-1));
		if (last.includes("secret word")) {
			// A fork inherits the parent's conversation: the secret is in an earlier message.
			const secret = msgs.map(textOf).join("\n").match(/SECRET-\d+/)?.[0] ?? "none";
			return fauxAssistantMessage(`the secret is ${secret}`);
		}
		return fauxAssistantMessage(last.includes("what is 2+2") ? "ANSWER 4" : "hello from kid");
	});
}
