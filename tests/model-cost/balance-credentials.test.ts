/**
 * Regression coverage for the DeepSeek balance credential contract.
 *
 * OMP < 18.3 resolved `modelRegistry.resolver(provider)` to a bare bearer
 * string; OMP >= 18.3 resolves `{ apiKey, credentialId }`. Passing the object
 * straight into `Authorization: Bearer …` produced `Bearer [object Object]`,
 * so DeepSeek answered 401 and the widget silently dropped its `Bal:` segment.
 */

import { describe, expect, test } from "bun:test";

import {
  extensionContext,
  fire,
  mountExtension,
  renderLastWidget,
  withTemporaryHome,
} from "./extension-harness";

/** Fake DeepSeek that rejects anything but the expected bearer, like the real API. */
function installBalanceFetch(expectedBearer: string): { auth: string[]; restore: () => void } {
  const auth: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const header = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
    auth.push(header);
    if (header !== `Bearer ${expectedBearer}`) {
      return new Response(JSON.stringify({ error: "Authentication Fails" }), { status: 401 });
    }
    return new Response(
      JSON.stringify({ balance_infos: [{ currency: "CNY", total_balance: "40.26" }] }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { auth, restore: () => { globalThis.fetch = originalFetch; } };
}

async function renderDeepSeekWidget(resolver: (provider: string) => unknown): Promise<string> {
  const { handlers } = mountExtension();
  const { ctx, widgetContents } = extensionContext(
    225_000,
    { id: "deepseek-flash", provider: "deepseek" },
    { resolver },
  );
  await fire(handlers, "agent_start", ctx);
  return renderLastWidget(widgetContents, 140)[0] ?? "";
}

describe("model-cost DeepSeek balance credentials", () => {
  test("unwraps the OMP >= 18.3 ResolvedApiKey and renders Bal", async () => {
    await withTemporaryHome(async () => {
      const fetchSpy = installBalanceFetch("sk-object-key");
      try {
        const line = await renderDeepSeekWidget(
          () => async ({ error }: { error: unknown }) =>
            error === undefined ? { apiKey: "sk-object-key", credentialId: 7 } : undefined,
        );
        expect(fetchSpy.auth[0]).toBe("Bearer sk-object-key");
        expect(line).toContain("Bal: \u00A540.26");
      } finally {
        fetchSpy.restore();
      }
    });
  });

  test("still accepts the OMP < 18.3 bare-string resolver", async () => {
    await withTemporaryHome(async () => {
      const fetchSpy = installBalanceFetch("sk-string-key");
      try {
        const line = await renderDeepSeekWidget(() => async () => "sk-string-key");
        expect(fetchSpy.auth[0]).toBe("Bearer sk-string-key");
        expect(line).toContain("Bal: \u00A540.26");
      } finally {
        fetchSpy.restore();
      }
    });
  });
});
