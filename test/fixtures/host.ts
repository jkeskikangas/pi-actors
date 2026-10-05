// A fake pi host for src/index.ts: the same surface the extension uses, with switches for the
// host behaviours the review found risky (tools in parallel, pi clearing its message queues).

import piActors from "../../src/index.ts";

export interface HostOptions {
	sessionId?: string;
	sessionFile?: string;
	cwd: string;
	flags?: Record<string, string>;
	/** What happens to pushed messages: "persist" (normal), "drop" (pi cleared its queues). */
	push?: "persist" | "drop";
}

export function fakeHost(opts: HostOptions) {
	const tools: Record<string, any> = {};
	const commands: Record<string, any> = {};
	const handlers: Record<string, Function[]> = {};
	const listeners: Record<string, Function[]> = {};
	const entries: any[] = [];
	const pushed: { content: string; details: any; options: any }[] = [];
	const notes: string[] = [];
	const events: { name: string; data: any }[] = [];
	let push = opts.push ?? "persist";
	const pi: any = {
		registerFlag() {},
		getFlag: (name: string) => opts.flags?.[name],
		registerTool: (t: any) => (tools[t.name] = t),
		registerCommand: (name: string, c: any) => (commands[name] = c),
		on: (ev: string, h: Function) => (handlers[ev] ??= []).push(h),
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		sendMessage: (m: any, options: any) => {
			pushed.push({ content: m.content, details: m.details, options });
			if (push === "persist") entries.push({ type: "custom_message", customType: m.customType, content: m.content, details: m.details });
		},
		events: {
			emit: (name: string, data: any) => {
				events.push({ name, data });
				for (const h of listeners[name] ?? []) h(data);
			},
			on: (name: string, h: Function) => (listeners[name] ??= []).push(h),
		},
	};
	const ctx: any = {
		cwd: opts.cwd,
		mode: "rpc",
		hasUI: false,
		ui: { notify: (s: string) => notes.push(s), setWidget() {}, onTerminalInput() {}, getEditorText: () => "" },
		abort() {},
		shutdown() {},
		sessionManager: {
			getSessionId: () => opts.sessionId ?? "s-root",
			getSessionFile: () => opts.sessionFile,
			getEntries: () => entries,
		},
	};
	piActors(pi);
	const fire = async (ev: string, e: any = {}) => {
		for (const h of handlers[ev] ?? []) await h(e, ctx);
	};
	const tool = (name: string, params: any) => tools[name].execute(`call-${Math.random()}`, params, undefined, undefined, ctx);
	const command = (name: string, args = "") => commands[name].handler(args, ctx);
	/** Pushed bodies so far, joined. */
	const inbox = () => pushed.map((p) => p.content).join("\n");
	const waitFor = async (pred: () => boolean, ms = 10_000) => {
		const end = Date.now() + ms;
		while (!pred()) {
			if (Date.now() > end) throw new Error(`timeout; pushed so far:\n${inbox()}\nnotes: ${notes.join(" | ")}`);
			await new Promise((r) => setTimeout(r, 50));
		}
	};
	return {
		pi, ctx, tools, entries, pushed, notes, events, fire, tool, command, inbox, waitFor,
		setPush: (p: "persist" | "drop") => (push = p),
	};
}
