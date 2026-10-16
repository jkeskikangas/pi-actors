import assert from "node:assert/strict";
import { test } from "node:test";
import { fastPayload, supportsFast } from "../src/client/fast.ts";

const anthropic = { api: "anthropic-messages", provider: "anthropic" };

test("anthropic: speed fast and the beta, created or merged without duplicates", () => {
	assert.deepEqual(fastPayload({ model: "m" }, anthropic), { model: "m", speed: "fast", betas: ["fast-mode-2026-02-01"] });
	assert.deepEqual(fastPayload({ betas: ["x"] }, anthropic), { betas: ["x", "fast-mode-2026-02-01"], speed: "fast" });
	assert.deepEqual(fastPayload({ betas: ["fast-mode-2026-02-01"] }, anthropic), { betas: ["fast-mode-2026-02-01"], speed: "fast" });
});

test("openai apis: priority service tier", () => {
	for (const api of ["openai-responses", "openai-codex-responses", "openai-completions"]) {
		assert.equal(supportsFast({ api }), true);
		assert.deepEqual(fastPayload({ model: "m" }, { api, provider: "openai" }), { model: "m", service_tier: "priority" });
	}
});

test("unsupported api or non-object payload leaves the payload alone", () => {
	assert.equal(supportsFast({ api: "claude-sdk", provider: "claude-sdk" }), false);
	assert.equal(supportsFast(undefined), false);
	assert.equal(fastPayload({ model: "m" }, { api: "google-generative-ai" }), undefined);
	assert.equal(fastPayload(undefined, anthropic), undefined);
	assert.equal(fastPayload("text", anthropic), undefined);
	assert.equal(fastPayload([1], anthropic), undefined);
});

test("the input payload is not mutated", () => {
	const p = { betas: ["x"] };
	const out = fastPayload(p, anthropic) as { betas: string[] };
	assert.deepEqual(p, { betas: ["x"] });
	assert.notEqual(out.betas, p.betas);
});
