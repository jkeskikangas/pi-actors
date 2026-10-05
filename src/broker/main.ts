// Broker process entry: node <runtime>/broker/main.ts <treeDir> <socket> <config.json>
import { readFileSync } from "node:fs";
import type { Config } from "../runtime.ts";
import { startBroker } from "./server.ts";

const [dir, sock, configPath] = process.argv.slice(2);
if (!dir || !sock || !configPath) {
	console.error("usage: broker <treeDir> <socket> <config.json>");
	process.exit(2);
}
const config = JSON.parse(readFileSync(configPath, "utf8")) as Config;
try {
	const broker = await startBroker(dir, sock, config);
	console.log(`broker ${process.pid} listening on ${sock}`);
	for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => void broker.stop());
	await broker.done;
	process.exit(0);
} catch (err) {
	console.error(String(err));
	process.exit(1);
}
