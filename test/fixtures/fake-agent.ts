// A fake child agent: speaks the pi-actors protocol without pi or a model.
// Behaviour comes from its task: "echo" (reply to the parent, then exit), "serve" (answer
// requests and echo mail until told "bye"), "crash" (exit 3 without the exit op).
import { Client } from "../../src/client/connection.ts";
import type { Message } from "../../src/protocol.ts";

const flag = (name: string) => process.argv.find((a) => a.startsWith(`--actors-${name}=`))?.split("=").slice(1).join("=");
const c = new Client({ socket: flag("socket")!, id: flag("id")!, inc: Number(flag("inc")), pid: process.pid });
c.on("terminate", () => process.exit(0));
c.on("lost", () => process.exit(4));
await c.start();

async function next(): Promise<Message> {
	for (;;) {
		const m = await c.fetch({});
		if (m) return m;
		await c.waitForMail(200);
	}
}

const task = await next();
c.ack(task.id);
const parent = task.from;
if (task.body === "crash") process.exit(3);
if (task.body === "echo") {
	await c.op("send", { to: parent, kind: "mail", body: `echo:${task.body}` });
	await c.op("exit", { result: "echoed" });
	await new Promise(() => {}); // wait for terminate
}
// serve
for (;;) {
	const m = await next();
	c.ack(m.id);
	if (m.body === "bye") {
		await c.op("exit", { result: "served" });
		await new Promise(() => {});
	}
	if (m.kind === "call") await c.op("send", { kind: "reply", ref: m.ref, to: "", body: `re:${m.body}` });
	else await c.op("send", { to: m.from, kind: "mail", body: `echo:${m.body}` });
}
