import { installFaux, fauxAssistantMessage } from "../_lib/faux.ts";
export default function (pi: any) { installFaux(pi, () => fauxAssistantMessage("hello from faux")); }
