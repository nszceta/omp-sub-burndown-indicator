import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
import type { DisplaySettings } from "./config.ts";
import { IndicatorController } from "./runtime/controller.ts";
import { defaultSettingsPath, loadDisplaySettings, updateDisplaySettings } from "./settings.ts";

const USAGE =
  "Usage: /burndown status | labels <full|masked|provider-only> | density <dense|text> | layout <fit|wrap> | exhausted <status|reset|label <full|symbol>> | provider truncate <0-256>";

type CompletionOption = Readonly<AutocompleteItem>;

const subcommands: readonly CompletionOption[] = [
  {
    value: "status",
    label: "status",
    description: "Show the current subscription burndown status",
  },
  { value: "labels", label: "labels", description: "Choose how account labels are shown" },
  { value: "density", label: "density", description: "Choose the display density" },
  { value: "layout", label: "layout", description: "Choose the widget layout" },
  {
    value: "exhausted",
    label: "exhausted",
    description: "Choose how exhausted subscriptions are displayed",
  },
  { value: "provider", label: "provider", description: "Configure provider labels" },
];

const subcommandOptions: Readonly<Record<string, readonly CompletionOption[]>> = {
  labels: [
    { value: "labels full", label: "full", description: "Show full account labels" },
    { value: "labels masked", label: "masked", description: "Mask account labels" },
    {
      value: "labels provider-only",
      label: "provider-only",
      description: "Show only the provider name",
    },
  ],
  density: [
    { value: "density dense", label: "dense", description: "Use the compact display" },
    { value: "density text", label: "text", description: "Use the text display" },
  ],
  layout: [
    { value: "layout fit", label: "fit", description: "Fit the widget to its content" },
    { value: "layout wrap", label: "wrap", description: "Allow the widget content to wrap" },
  ],
  exhausted: [
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
  ],
  provider: [
    {
      value: "provider truncate",
      label: "truncate",
      description: "Set the provider-label column limit (0 disables clipping)",
    },
  ],
};

function completeCommand(prefix: string): AutocompleteItem[] | null {
  const normalized = prefix.trimStart().toLowerCase();
  if (!normalized) return [...subcommands];

  const match = /^(\S+)(?:\s+(.*))?$/.exec(normalized);
  if (!match) return null;

  const subcommand = match[1] ?? "";
  const valuePrefix = match[2];
  if (valuePrefix === undefined) {
    const matches = subcommands.filter((option) => option.value.startsWith(subcommand));
    return matches.length ? matches : null;
  }

  const options = subcommandOptions[subcommand];
  if (!options) return null;
  const matches = options.filter((option) => option.label.startsWith(valuePrefix));
  return matches.length ? matches : null;
}

async function displaySettings(): Promise<DisplaySettings> {
  try {
    return await loadDisplaySettings();
  } catch {
    return {};
  }
}

export { IndicatorController, WIDGET_KEY } from "./runtime/controller.ts";

export default function subscriptionBurndownExtension(pi: ExtensionAPI): void {
  const controller = new IndicatorController();

  pi.on("session_start", async (_event, ctx) => {
    await controller.start(ctx, await displaySettings());
  });
  pi.on("session_switch", async (_event, ctx) => {
    await controller.restart(ctx, await displaySettings());
  });
  pi.on("session_tree", async (_event, ctx) => {
    await controller.restart(ctx, await displaySettings());
  });
  pi.on("session_shutdown", (_event, ctx) => {
    controller.shutdown(ctx);
  });
  pi.on("after_provider_response", (event, ctx) => {
    controller.ingestResponse(event, ctx);
  });

  pi.registerCommand("burndown", {
    description: "Show or change subscription burndown display settings",
    getArgumentCompletions: completeCommand,
    handler: async (args, ctx) => {
      const [command, value, extra] = args.trim().split(/\s+/);
      if (command === "status" && value === undefined) {
        if (ctx.hasUI) ctx.ui.notify(controller.status(), "info");
        return;
      }
      const changes: DisplaySettings =
        command === "labels" &&
        (value === "full" || value === "masked" || value === "provider-only") &&
        extra === undefined
          ? { accountLabels: value }
          : command === "density" && (value === "dense" || value === "text") && extra === undefined
            ? { density: value }
            : command === "layout" && (value === "fit" || value === "wrap") && extra === undefined
              ? { layout: value }
              : command === "exhausted" &&
                  (value === "status" || value === "reset") &&
                  extra === undefined
                ? { exhaustedDisplay: value }
                : command === "exhausted" &&
                    value === "label" &&
                    (extra === "full" || extra === "symbol")
                  ? { exhaustedLabel: extra }
                  : command === "provider" &&
                      value === "truncate" &&
                      extra !== undefined &&
                      /^\d+$/.test(extra) &&
                      Number(extra) <= 256
                    ? { providerLabelMaxColumns: Number(extra) }
                    : {};
      if (Object.keys(changes).length === 0) {
        if (ctx.hasUI) ctx.ui.notify(USAGE, "warning");
        return;
      }
      await updateDisplaySettings(defaultSettingsPath(), changes);
      await controller.restart(ctx, await displaySettings());
      if (ctx.hasUI) ctx.ui.notify("Burndown display updated.", "info");
    },
  });
}
