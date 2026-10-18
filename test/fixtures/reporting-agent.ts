// Runs the real extension lifecycle against a broker, without a model provider.
import { fakeHost } from "./host.ts";

const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--actors-")).map((a) => {
	const at = a.indexOf("=");
	return [a.slice(2, at), a.slice(at + 1)];
}));
// The fake host loads the source extension, not the broker's staged runtime copy.
process.argv = process.argv.filter((a) => !a.startsWith("--actors-runtime="));
const h = fakeHost({ cwd: process.cwd(), flags, sessionFile: "/tmp/reporting-agent.jsonl" });
await h.fire("session_start", { reason: "startup" });
let handled = 0;
for (;;) {
	await h.waitFor(() => h.pushed.length > handled, 60_000);
	const task = h.pushed[handled++].details.actors.messages[0].body;
	await h.fire("input", { source: task === "interactive" ? "interactive" : "rpc" });
	await h.fire("agent_start");
	const message = async (stopReason: string, text = "", errorMessage?: string) => h.fire("message_end", {
		message: { role: "assistant", content: text ? [{ type: "text", text }] : [], stopReason, errorMessage },
	});
	if (task === "partial") await message("toolUse", "I will investigate.");
	if (task === "success") await message("stop", "Recovered successfully.");
	else {
		await message("error", "", task === "fallback" ? undefined : task === "long" ? "x".repeat(20_000) : "Provider is not configured: anthropic");
		if (task === "retry") await message("stop", "Retry succeeded.");
	}
	await Promise.all([h.fire("agent_settled", { aborted: false }), h.fire("agent_settled", { aborted: false })]);
	await h.fire("agent_settled", { aborted: false });
	await h.tool("send", { to: "parent", text: `fixture settled: ${task}` });
}
