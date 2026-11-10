// Broker process entry: node <runtime>/broker/main.ts <treeDir> <socket> <config.json>
import { isIoError, loadConfig } from "../runtime.ts";
import { startBroker } from "./server.ts";

const [dir, sock, configPath] = process.argv.slice(2);
if (!dir || !sock || !configPath) {
	console.error("usage: broker <treeDir> <socket> <config.json>");
	process.exit(2);
}
const { config, problem } = loadConfig(configPath);
if (problem) console.error(`${new Date().toISOString()} ${problem}${config ? `; using ${configPath}.bak` : " and has no usable backup"}`);
if (!config) process.exit(1);
// A full or failing disk must not kill the tree: the broker keeps serving from memory and retries
// its writes. Anything else is a bug: crash as before, a Keeper-held tree survives a restart.
const fatal = (kind: string) => (err: unknown) => {
	if (isIoError(err)) return console.error(`${new Date().toISOString()} ${kind} (I/O, kept running):`, err);
	console.error(`${kind}:`, err);
	process.exit(1);
};
process.on("uncaughtException", fatal("uncaught exception"));
process.on("unhandledRejection", fatal("unhandled rejection"));
try {
	const broker = await startBroker(dir, sock, config);
	console.log(`broker ${process.pid} listening on ${sock}`);
	// A signal stops this process, not the tree: Keepers wait out the grace period and reconnect
	// to a relaunched broker. Only `stop_tree` (or every agent ending) finishes the tree.
	for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => void broker.close());
	await broker.done;
	process.exit(0);
} catch (err) {
	console.error(String(err));
	process.exit(1);
}
