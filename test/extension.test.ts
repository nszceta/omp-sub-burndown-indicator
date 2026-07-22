import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const isolatedRoot = mkdtempSync(join(tmpdir(), "omp-sub-burndown-indicator-test-"));
const isolatedEnv = {
  HOME: isolatedRoot,
  XDG_CONFIG_HOME: join(isolatedRoot, "config"),
  XDG_DATA_HOME: join(isolatedRoot, "data"),
  XDG_STATE_HOME: join(isolatedRoot, "state"),
  XDG_CACHE_HOME: join(isolatedRoot, "cache"),
};
const previousEnv = {
  HOME: process.env.HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
};
Object.assign(process.env, isolatedEnv);

// Import after isolating XDG paths so plugin settings never read the user's home.
const { default: subscriptionBurndownExtension, WIDGET_KEY } = await import("../src/index.ts");

afterAll(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(isolatedRoot, { recursive: true, force: true });
});

type Handler = (
  event: { type: string; headers?: Record<string, string>; status?: number },
  ctx: ExtensionContext,
) => Promise<void> | void;

type CommandCompletion = {
  value: string;
  label: string;
  description: string;
};

function fakeContext(hasUI: boolean) {
  const widgets: Array<{ key: string; content: unknown; placement?: string }> = [];
  const notifications: string[] = [];
  const model = { provider: "anthropic", id: "claude" };
  const ctx = {
    cwd: isolatedRoot,
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

test("default factory registers public lifecycle, response, and unified burndown command contracts", async () => {
  const handlers = new Map<string, Handler>();
  let command:
    | {
        name: string;
        getArgumentCompletions?: (prefix: string) => CommandCompletion[] | null;
        handler: (args: string, ctx: ExtensionContext) => Promise<void>;
      }
    | undefined;
  const api = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerCommand: (
      name: string,
      options: {
        getArgumentCompletions?: (prefix: string) => CommandCompletion[] | null;
        handler: (args: string, ctx: ExtensionContext) => Promise<void>;
      },
    ) => {
      command = {
        name,
        ...(options.getArgumentCompletions
          ? { getArgumentCompletions: options.getArgumentCompletions }
          : {}),
        handler: options.handler,
      };
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
  expect(command?.name).toBe("burndown");
  expect(command?.getArgumentCompletions?.("")).toEqual([
    {
      value: "status",
      label: "status",
      description: "Show the current subscription burndown status",
    },
    {
      value: "labels",
      label: "labels",
      description: "Choose how account labels are shown",
    },
    {
      value: "density",
      label: "density",
      description: "Choose the display density",
    },
    {
      value: "layout",
      label: "layout",
      description: "Choose the widget layout",
    },
    {
      value: "exhausted",
      label: "exhausted",
      description: "Choose how exhausted subscriptions are displayed",
    },
    {
      value: "provider",
      label: "provider",
      description: "Configure provider labels",
    },
  ]);
  expect(command?.getArgumentCompletions?.("labels ")).toEqual([
    { value: "labels full", label: "full", description: "Show full account labels" },
    { value: "labels masked", label: "masked", description: "Mask account labels" },
    {
      value: "labels provider-only",
      label: "provider-only",
      description: "Show only the provider name",
    },
  ]);
  expect(command?.getArgumentCompletions?.("density ")).toEqual([
    { value: "density dense", label: "dense", description: "Use the compact display" },
    { value: "density text", label: "text", description: "Use the text display" },
  ]);
  expect(command?.getArgumentCompletions?.("layout ")).toEqual([
    { value: "layout fit", label: "fit", description: "Fit the widget to its content" },
    { value: "layout wrap", label: "wrap", description: "Allow the widget content to wrap" },
  ]);
  expect(command?.getArgumentCompletions?.("exhausted ")).toEqual([
    { value: "exhausted status", label: "status", description: "Show exhaustion status" },
    { value: "exhausted reset", label: "reset", description: "Show the reset time" },
    {
      value: "exhausted label full",
      label: "label full",
      description: "Show the full exhausted label",
    },
    {
      value: "exhausted label symbol",
      label: "label symbol",
      description: "Show only the exhausted symbol",
    },
  ]);
  expect(command?.getArgumentCompletions?.("status ")).toBeNull();
  expect(command?.getArgumentCompletions?.("provider ")).toEqual([
    {
      value: "provider truncate",
      label: "truncate",
      description: "Set the provider-label column limit (0 disables clipping)",
    },
  ]);

  const interactive = fakeContext(true);
  await handlers.get("session_start")?.({ type: "session_start" }, interactive.ctx);
  const installed = interactive.widgets.find((entry) => entry.content !== undefined);
  expect(installed?.key).toBe(WIDGET_KEY);
  expect(installed?.placement).toBe("aboveEditor");
  expect(typeof installed?.content).toBe("function");

  await command?.handler("status", interactive.ctx);
  expect(interactive.notifications[0]).toContain("Burndown status");

  interactive.notifications.length = 0;
  await command?.handler("labels masked", interactive.ctx);
  expect(interactive.notifications[0]).toBeDefined();
  expect(interactive.notifications[0]).not.toContain("Usage: /burndown");
  expect(readFileSync(join(isolatedRoot, ".omp", "agent", "burndown.yml"), "utf8")).toContain(
    "accountLabels: masked",
  );

  interactive.notifications.length = 0;
  await command?.handler("provider truncate 8", interactive.ctx);
  expect(interactive.notifications[0]).not.toContain("Usage: /burndown");
  expect(readFileSync(join(isolatedRoot, ".omp", "agent", "burndown.yml"), "utf8")).toContain(
    "providerLabelMaxColumns: 8",
  );

  interactive.notifications.length = 0;
  await command?.handler("exhausted label symbol", interactive.ctx);
  expect(interactive.notifications[0]).not.toContain("Usage: /burndown");
  expect(readFileSync(join(isolatedRoot, ".omp", "agent", "burndown.yml"), "utf8")).toContain(
    "exhaustedLabel: symbol",
  );

  interactive.notifications.length = 0;
  await command?.handler("provider truncate 999", interactive.ctx);
  expect(interactive.notifications[0]).toContain("Usage: /burndown");
  expect(readFileSync(join(isolatedRoot, ".omp", "agent", "burndown.yml"), "utf8")).toContain(
    "providerLabelMaxColumns: 8",
  );

  interactive.notifications.length = 0;
  await command?.handler("labels", interactive.ctx);
  expect(interactive.notifications[0]).toContain("Usage: /burndown");
  expect(readFileSync(join(isolatedRoot, ".omp", "agent", "burndown.yml"), "utf8")).toContain(
    "accountLabels: masked",
  );

  interactive.notifications.length = 0;
  await command?.handler("labels hidden", interactive.ctx);
  expect(interactive.notifications[0]).toContain("Usage: /burndown");
  expect(readFileSync(join(isolatedRoot, ".omp", "agent", "burndown.yml"), "utf8")).toContain(
    "accountLabels: masked",
  );

  interactive.notifications.length = 0;
  await command?.handler("", interactive.ctx);
  expect(interactive.notifications[0]).toContain("Usage: /burndown");

  interactive.notifications.length = 0;
  await command?.handler("unknown", interactive.ctx);
  expect(interactive.notifications[0]).toContain("Usage: /burndown");

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
