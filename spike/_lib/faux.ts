// Shared scripted fake provider for spikes. Model: faux/faux-1. No network, deterministic.
// script(ctx) is called per model request with { calls, toolResults } and returns an AssistantMessage.
import { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from "@earendil-works/pi-ai";
export { fauxAssistantMessage, fauxToolCall, fauxText };

export function installFaux(pi: any, script: (info: { call: number; context: any }) => any) {
  const faux = fauxProvider({ provider: "faux", api: "faux", models: [{ id: "faux-1" }, { id: "faux-2" }] });
  let call = 0;
  const step = (context: any) => script({ call: call++, context });
  // Effectively infinite scripted responses.
  faux.setResponses(Array.from({ length: 200 }, () => step));
  pi.registerProvider(faux.provider);
  return faux;
}
