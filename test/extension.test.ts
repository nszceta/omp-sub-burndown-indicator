import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import subscriptionBurndownExtension from "../src/index.ts";
import { WIDGET_KEY } from "../src/runtime/controller.ts";

type Handler = (
  event: { type: string; headers?: Record<string, string>; status?: number },
  ctx: ExtensionContext,
) => Promise<void> | void;

function fakeContext(hasUI: boolean) {
  const widgets: Array<{ key: string; content: unknown; placement?: string }> = [];
  const notifications: string[] = [];
  const model = { provider: "anthropic", id: "claude" };
  const ctx = {
    cwd: process.cwd(),
    hasUI,
    model,
    models: {
      list: () => [model],
      current: () => model,
      resolve: () => undefined,
      family: () => "claude",
    },
    ui: {
      setWidget: (key: string, content: unknown, options?: { placement?: string }) => {
        widgets.push({
          key,
          content,
          ...(options?.placement ? { placement: options.placement } : {}),
        });
      },
      notify: (message: string) => notifications.push(message),
    },
  } as unknown as ExtensionContext;
  return { ctx, widgets, notifications };
}

test("default factory registers public lifecycle, response, and diagnostic contracts", async () => {
  const handlers = new Map<string, Handler>();
  let command:
    | { name: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }
    | undefined;
  const api = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerCommand: (
      name: string,
      options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> },
    ) => {
      command = { name, handler: options.handler };
    },
  } as unknown as ExtensionAPI;

  subscriptionBurndownExtension(api);
  expect([...handlers.keys()].sort()).toEqual([
    "after_provider_response",
    "session_shutdown",
    "session_start",
    "session_switch",
    "session_tree",
  ]);
  expect(command?.name).toBe("burndown-status");

  const interactive = fakeContext(true);
  await handlers.get("session_start")?.({ type: "session_start" }, interactive.ctx);
  const installed = interactive.widgets.find((entry) => entry.content !== undefined);
  expect(installed?.key).toBe(WIDGET_KEY);
  expect(installed?.placement).toBe("aboveEditor");
  expect(typeof installed?.content).toBe("function");

  await command?.handler("", interactive.ctx);
  expect(interactive.notifications[0]).toContain("Burndown status");
  await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, interactive.ctx);
  expect(interactive.widgets.at(-1)?.content).toBeUndefined();
});

test("headless and component-stubbing hosts degrade without throwing", async () => {
  const handlers = new Map<string, Handler>();
  const api = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerCommand: () => undefined,
  } as unknown as ExtensionAPI;
  subscriptionBurndownExtension(api);

  const headless = fakeContext(false);
  await handlers.get("session_start")?.({ type: "session_start" }, headless.ctx);
  expect(headless.widgets).toEqual([]);

  const stub = fakeContext(true);
  stub.ctx.ui.setWidget = () => {
    throw new Error("component factories unsupported");
  };
  await expect(
    handlers.get("session_switch")?.({ type: "session_switch" }, stub.ctx),
  ).resolves.toBeUndefined();
  await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, stub.ctx);
});
