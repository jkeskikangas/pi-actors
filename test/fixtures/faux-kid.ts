// Scripted child agent for the live test: final answers become reports.
import { fauxAssistantMessage, installFaux } from "./faux.ts";

const textOf = (m: any): string =>
	typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((b: any) => b.text ?? "").join("") : "";

import { fauxToolCall } from "./faux.ts";

export default function (pi: any) {
	installFaux(pi, ({ call, context }) => {
		const msgs = context.messages ?? [];
		const last = textOf(msgs.at(-1));
		if (last.includes("The human answered")) return fauxAssistantMessage(`ANSWER RECEIVED: ${last.split("\n").slice(-3).join(" ")}`);
		if (last.includes("ask the human")) return fauxAssistantMessage(fauxToolCall("send", { to: "human", text: "REST or GraphQL?" }, { id: `k${call}` }), { stopReason: "toolUse" });
		if (last.includes("The human's answer will arrive")) return fauxAssistantMessage("asked");
		if (last.includes("secret word")) {
			// A fork inherits the parent's conversation: the secret is in an earlier message.
			const secret = msgs.map(textOf).join("\n").match(/SECRET-\d+/)?.[0] ?? "none";
			return fauxAssistantMessage(`the secret is ${secret}`);
		}
		return fauxAssistantMessage(last.includes("what is 2+2") ? "ANSWER 4" : "hello from kid");
	});
}
