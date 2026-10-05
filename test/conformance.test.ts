// Design "Conformance rules": import direction and dependency hygiene, checked mechanically.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const files = (dir: string): string[] =>
	readdirSync(dir).flatMap((f) => {
		const p = join(dir, f);
		return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
	});
const imports = (file: string) => [...readFileSync(file, "utf8").matchAll(/^\s*import[^"']*["']([^"']+)["']/gm)].map((m) => m[1]);

test("protocol.ts and tree.ts import nothing but each other", () => {
	assert.deepEqual(imports("src/protocol.ts"), []);
	assert.deepEqual(imports("src/tree.ts").filter((i) => i !== "./protocol.ts"), []);
});

test("broker, keeper and placement never import typebox or pi", () => {
	for (const f of files("src").filter((f) => /src\/(broker|keeper|placement)\//.test(f))) {
		for (const i of imports(f)) assert.ok(!/^typebox|^@earendil-works\//.test(i), `${f} imports ${i}`);
	}
});

test("client code imports only protocol.ts from the core; only the broker server imports placement", () => {
	for (const f of files("src").filter((f) => f.startsWith("src/client/"))) {
		for (const i of imports(f)) assert.ok(!/tree\.ts|\/broker\/|\/keeper\/|\/placement\//.test(i), `${f} imports ${i}`);
	}
	for (const f of files("src").filter((f) => f !== "src/broker/server.ts")) {
		for (const i of imports(f)) assert.ok(!/\/placement\//.test(i), `${f} imports ${i}`);
	}
});

test("package.json: no runtime dependencies; host packages are * peers", () => {
	const pkg = JSON.parse(readFileSync("package.json", "utf8"));
	assert.equal(pkg.dependencies, undefined);
	for (const v of Object.values(pkg.peerDependencies)) assert.equal(v, "*");
});
