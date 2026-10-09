// A fake pi host for src/index.ts: the same surface the extension uses, with switches for the
// host behaviours the review found risky (tools in parallel, pi clearing its message queues).

import piActors from "../../src/index.ts";

export interface HostOptions {
	sessionId?: string;
	sessionFile?: string;
	cwd: string;
	flags?: Record<string, string>;
	/**
	 * What happens to pushed messages: "persist" (normal), "drop" (pi cleared its queues), or
	 * "keep" (pi kept them queued across an aborted run; `drainQueue()` delivers them later).
	 */
	push?: "persist" | "drop" | "keep";
	/** "tui" adds the interactive UI surface the panel uses. */
	mode?: "rpc" | "tui";
}

export function fakeHost(opts: HostOptions) {
	const tools: Record<string, any> = {};
	const commands: Record<string, any> = {};
	const renderers: Record<string, any> = {};
	const handlers: Record<string, Function[]> = {};
	const listeners: Record<string, Function[]> = {};
	const entries: any[] = [];
	const pushed: { content: string; details: any; options: any }[] = [];
	const notes: string[] = [];
	const events: { name: string; data: any }[] = [];
	let push = opts.push ?? "persist";
	const queued: any[] = [];
	const widgets: Record<string, string[] | undefined> = {};
	const inputs: string[] = [];
	let overlay: { component: any; done: (v: unknown) => void } | undefined;
	const pi: any = {
		registerFlag() {},
		getFlag: (name: string) => opts.flags?.[name],
		registerTool: (t: any) => (tools[t.name] = t),
		registerCommand: (name: string, c: any) => (commands[name] = c),
		registerMessageRenderer: (type: string, r: any) => (renderers[type] = r),
		on: (ev: string, h: Function) => (handlers[ev] ??= []).push(h),
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		sendMessage: (m: any, options: any) => {
			pushed.push({ content: m.content, details: m.details, options });
			const entry = { type: "custom_message", customType: m.customType, content: m.content, details: m.details };
			if (push === "persist") entries.push(entry);
			else if (push === "keep") queued.push(entry);
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
		mode: opts.mode ?? "rpc",
		hasUI: opts.mode === "tui",
		ui: {
			notify: (s: string) => notes.push(s),
			setWidget: (key: string, lines: string[] | undefined) => (widgets[key] = lines),
			onTerminalInput() {},
			getEditorText: () => "",
			confirm: async () => true,
			input: async () => inputs.shift(),
			custom: (factory: any) =>
				new Promise((resolve) => {
					const done = (v: unknown) => {
						overlay = undefined;
						resolve(v);
					};
					const component = factory({ requestRender() {}, terminal: { rows: 40 } }, { fg: (_c: string, t: string) => t }, {}, done);
					overlay = { component, done };
				}),
		},
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
	/** The messages pi would hand the model, after every `context` handler (as pi chains them). */
	const context = async () => {
		let messages = entries.filter((e) => e.type === "custom_message").map((e) => ({ role: "custom", customType: e.customType, content: e.content, details: e.details }));
		for (const h of handlers.context ?? []) {
			const r = await h({ type: "context", messages }, ctx);
			if (r?.messages) messages = r.messages;
		}
		return messages;
	};
	const keys: Record<string, string> = { up: "\x1b[A", down: "\x1b[B", enter: "\r", escape: "\x1b", space: " " };
	/** Press keys in the open overlay. */
	const press = (...ks: string[]) => {
		for (const k of ks) overlay?.component.handleInput(keys[k] ?? k);
	};
	return {
		pi, ctx, tools, entries, pushed, notes, events, widgets, inputs, renderers, fire, tool, command, inbox, waitFor, context, press,
		overlayLines: (width = 120) => overlay?.component.render(width) ?? [],
		overlayOpen: () => !!overlay,
		setPush: (p: "persist" | "drop" | "keep") => (push = p),
		/** pi delivers what it kept queued (the next run). */
		drainQueue: () => entries.push(...queued.splice(0)),
	};
}
