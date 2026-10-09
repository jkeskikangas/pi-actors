// An agent's transcript drawn the way pi draws the main session: pi's own message components, and
// tool rows through the same renderer chain (so a renderer extension such as
// pi-minimum-sufficient-output applies here too). Read incrementally from the agent's session file.

import { closeSync, openSync, readSync, statSync } from "node:fs";
import {
	AssistantMessageComponent,
	CustomMessageComponent,
	ExtensionRunner,
	getMarkdownTheme,
	type MessageRenderer,
	type ToolRenderers,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, type Component, Text, type TUI } from "@earendil-works/pi-tui";
import type { Message } from "../protocol.ts";
import { summarizeDelivery } from "./mailroom.ts";

/** One parsed session-file line; only the fields the transcript reads. */
export type SessionLine = {
	type?: string;
	cwd?: string;
	customType?: string;
	content?: unknown;
	display?: boolean;
	details?: unknown;
	message?: { role?: string; content?: unknown; toolCallId?: string; stopReason?: string; errorMessage?: string; isError?: boolean } & Record<string, unknown>;
};

/** Session files only grow: read just the bytes appended since the last look. */
const cache = new Map<string, { ino: number; size: number; rest: Buffer; lines: SessionLine[] }>();

export function readSession(sessionFile: string | undefined): SessionLine[] {
	if (!sessionFile) return [];
	let size: number;
	let ino: number;
	try {
		({ size, ino } = statSync(sessionFile));
	} catch {
		return [];
	}
	let c = cache.get(sessionFile);
	// A replaced or truncated file is read again from the start.
	if (!c || c.ino !== ino || size < c.size) c = { ino, size: 0, rest: Buffer.alloc(0), lines: [] };
	if (size > c.size) {
		const chunk = Buffer.alloc(size - c.size);
		let n: number;
		try {
			const fd = openSync(sessionFile, "r");
			try {
				n = readSync(fd, chunk, 0, chunk.length, c.size);
			} finally {
				closeSync(fd);
			}
		} catch {
			return c.lines;
		}
		// Split on bytes, so a multi-byte character cut at the end of a read stays whole.
		const all = Buffer.concat([c.rest, chunk.subarray(0, n)]);
		const cut = all.lastIndexOf(0x0a) + 1;
		const parsed = all
			.subarray(0, cut)
			.toString("utf8")
			.split("\n")
			.flatMap((l) => {
				if (!l) return [];
				try {
					const v = JSON.parse(l);
					return v && typeof v === "object" ? [v as SessionLine] : [];
				} catch {
					return [];
				}
			});
		c = { ino, size: c.size + n, rest: all.subarray(cut), lines: [...c.lines, ...parsed] };
	}
	cache.set(sessionFile, c);
	return c.lines;
}

// ---------------------------------------------------------------- deliveries

/** The collapsed chat line for a delivery; expanding it shows what the model read. */
export const renderDelivery: MessageRenderer<{ actors?: { messages?: Message[] } }> = (message, options, theme) => {
	const body = typeof message.content === "string" ? message.content : "";
	const msgs = message.details?.actors?.messages;
	const head = theme.fg("dim", `⇢ ${Array.isArray(msgs) && msgs.length ? summarizeDelivery(msgs) : body.split("\n")[0]}`);
	return new Text(options.expanded ? `${head}\n${theme.fg("muted", body)}` : head, options.outputPad, 0);
};

// ---------------------------------------------------------------- tool renderers

const RUNNER = Symbol.for("pi-actors.extensionRunner");
const PATCHED = Symbol.for("pi-actors.runnerCapture");
type Runner = { resolveToolRenderers(name: string, base: () => ToolRenderers | undefined): ToolRenderers | undefined; getToolDefinition(name: string): ToolRenderers | undefined };

/**
 * pi resolves a tool row's renderers through every extension's resolver, but offers extensions no
 * call for it. Remember the extension runner when it builds a context (it does for every event), so
 * the panel can ask it the same way the transcript does. Guarded: if pi changes shape, the panel
 * falls back to its own rows.
 */
export function captureRunner(): void {
	try {
		const proto = (ExtensionRunner as unknown as { prototype?: Record<PropertyKey, unknown> } | undefined)?.prototype;
		if (!proto || typeof proto.createContext !== "function" || proto[PATCHED]) return;
		const createContext = proto.createContext as (...a: unknown[]) => unknown;
		proto.createContext = function (this: object, ...a: unknown[]) {
			(globalThis as Record<PropertyKey, unknown>)[RUNNER] = new WeakRef(this);
			return createContext.apply(this, a);
		};
		proto[PATCHED] = true;
	} catch {
		// fall back to the panel's own rows
	}
}

function resolveRenderers(name: string): ToolRenderers | undefined {
	try {
		const runner = ((globalThis as Record<PropertyKey, unknown>)[RUNNER] as WeakRef<Runner> | undefined)?.deref();
		if (!runner || typeof runner.resolveToolRenderers !== "function") return undefined;
		return runner.resolveToolRenderers(name, () => runner.getToolDefinition?.(name));
	} catch {
		return undefined;
	}
}

/** The argument that says what a tool call did: a command, a path, a recipient. */
export function keyArg(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const a = args as Record<string, unknown>;
	for (const k of ["command", "path", "file_path", "pattern", "url", "query", "to", "name", "id", "task"]) if (typeof a[k] === "string" && a[k]) return a[k] as string;
	const first = Object.values(a).find((v): v is string => typeof v === "string");
	return first ?? "";
}

const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/ {2,}/g, " ").trim();
const textOf = (c: unknown): string =>
	typeof c === "string" ? c : Array.isArray(c) ? c.map((b: { type?: string; text?: string }) => (b?.type === "text" ? (b.text ?? "") : "")).join("\n") : "";

/** Rows for a tool nothing else draws (no renderer extension, a built-in tool): name and key argument. */
export const fallbackRenderers = (name: string): ToolRenderers => ({
	renderShell: "self",
	renderCall(args, theme, ctx) {
		const arg = oneLine(keyArg(args));
		return new Text(`${theme.fg("muted", name)}${arg ? ` ${theme.fg("text", arg)}` : ""}`, (ctx.outputPad ?? 1) + 2, 0);
	},
	renderResult(result, options, theme, ctx) {
		const text = textOf(result.content).replace(/\n+$/, "");
		const pad = (ctx.outputPad ?? 1) + 4;
		if (options.expanded) return new Text(theme.fg("toolOutput", text.replace(/\t/g, "  ")), pad, 0);
		if (!ctx.isError) return new Text("", 0, 0);
		return new Text(theme.fg("error", oneLine(text.split("\n").find((l) => l.trim()) ?? "error")), pad, 0);
	},
});

// ---------------------------------------------------------------- the transcript

export interface TranscriptOptions {
	outputPad: number;
	hideThinkingBlock: boolean;
}

// OSC 133 prompt marks (shell integration) mean nothing inside the panel.
const OSC133 = /\x1b\]133;[A-Z][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** One agent's transcript as pi components, extended as its session file grows. */
export class Transcript implements Component {
	private readonly root = new Container();
	private readonly pending = new Map<string, ToolExecutionComponent>();
	private readonly expandable: { setExpanded(e: boolean): void }[] = [];
	private consumed = 0;
	private expanded = false;
	private cwd: string;
	private readonly md = getMarkdownTheme();
	private readonly tui: TUI;
	private readonly opts: TranscriptOptions;

	constructor(tui: TUI, cwd: string, opts: TranscriptOptions) {
		this.tui = tui;
		this.cwd = cwd;
		this.opts = opts;
	}

	/** Add components for the lines not seen yet. A shorter list means the file was replaced. */
	sync(lines: readonly SessionLine[]): void {
		if (lines.length < this.consumed) {
			this.root.clear();
			this.pending.clear();
			this.expandable.length = 0;
			this.consumed = 0;
		}
		for (const line of lines.slice(this.consumed)) {
			try {
				this.add(line);
			} catch {
				// one odd line must not hide the rest
			}
		}
		this.consumed = lines.length;
	}

	get isEmpty(): boolean {
		return this.root.children.length === 0;
	}

	setExpanded(expanded: boolean): void {
		if (expanded === this.expanded) return;
		this.expanded = expanded;
		for (const c of this.expandable) c.setExpanded(expanded);
	}

	private add(line: SessionLine): void {
		const pad = this.opts.outputPad;
		if (line.type === "session" && typeof line.cwd === "string") this.cwd = line.cwd;
		if (line.type === "custom_message") {
			if (line.display === false) return;
			const msg = { role: "custom", customType: line.customType ?? "", content: line.content, display: true, details: line.details } as ConstructorParameters<typeof CustomMessageComponent>[0];
			const c = new CustomMessageComponent(msg, line.customType === "pi-actors" ? (renderDelivery as MessageRenderer) : undefined, this.md, pad);
			c.setExpanded(this.expanded);
			this.expandable.push(c);
			this.root.addChild(c);
			return;
		}
		const m = line.type === "message" ? line.message : undefined;
		if (!m) return;
		if (m.role === "user") {
			const text = textOf(m.content).trim();
			if (text) this.root.addChild(new UserMessageComponent(text, this.md, pad));
		} else if (m.role === "assistant") {
			this.root.addChild(new AssistantMessageComponent(m as unknown as ConstructorParameters<typeof AssistantMessageComponent>[0], this.opts.hideThinkingBlock, this.md, undefined, pad));
			for (const b of (Array.isArray(m.content) ? m.content : []) as { type?: string; id?: string; name?: string; arguments?: unknown }[]) {
				if (b?.type !== "toolCall") continue;
				const name = b.name ?? "tool";
				const tool = new ToolExecutionComponent(name, b.id ?? "", b.arguments ?? {}, { outputPad: pad, showImages: false }, resolveRenderers(name) ?? fallbackRenderers(name), this.tui, this.cwd);
				tool.setExpanded(this.expanded);
				this.expandable.push(tool);
				this.root.addChild(tool);
				if (m.stopReason === "aborted" || m.stopReason === "error") {
					tool.updateResult({ content: [{ type: "text", text: m.stopReason === "aborted" ? "Operation aborted" : (m.errorMessage ?? "Error") }], isError: true });
				} else if (b.id) this.pending.set(b.id, tool);
			}
		} else if (m.role === "toolResult" && m.toolCallId) {
			const tool = this.pending.get(m.toolCallId);
			if (!tool) return;
			this.pending.delete(m.toolCallId);
			tool.updateResult(m as Parameters<ToolExecutionComponent["updateResult"]>[0]);
		}
	}

	render(width: number): string[] {
		return this.root.render(width).map((l) => l.replace(OSC133, ""));
	}

	invalidate(): void {
		this.root.invalidate();
	}
}
