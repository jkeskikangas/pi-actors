// Provider fast mode, applied to a child's request payloads (spawn{fast: true}). Pure: no pi imports.

type ModelLike = { api?: string; provider?: string } | undefined;

const ANTHROPIC = new Set(["anthropic-messages"]);
const OPENAI = new Set(["openai-responses", "openai-codex-responses", "openai-completions"]);
const FAST_BETA = "fast-mode-2026-02-01";

export function supportsFast(model: ModelLike): boolean {
	return !!model?.api && (ANTHROPIC.has(model.api) || OPENAI.has(model.api));
}

/** A new payload with the fast-mode fields for the model's API; undefined leaves the payload as is. */
export function fastPayload(payload: unknown, model: ModelLike): unknown {
	if (!supportsFast(model) || !payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	const p = payload as Record<string, unknown>;
	if (OPENAI.has(model!.api!)) return { ...p, service_tier: "priority" };
	const betas = Array.isArray(p.betas) ? p.betas : [];
	return { ...p, speed: "fast", betas: betas.includes(FAST_BETA) ? [...betas] : [...betas, FAST_BETA] };
}
