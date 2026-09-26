/**
 * Prompt payloads for the codeBaseTools extension.
 *
 * Both files are imported as text at module load, so the injected strings are
 * compile-time constants with no runtime IO. `init.md` is the single source of
 * truth for the routing rules; `reminder.md` is a one-line pointer that invokes
 * the `【codeBaseTools 路由】` token defined by init.
 */
import init from "./prompts/init.md" with { type: "text" };
import reminder from "./prompts/reminder.md" with { type: "text" };

export const INIT_PROMPT = init;
export const REMINDER_PROMPT = reminder;
