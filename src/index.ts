import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { IndicatorController } from "./runtime/controller.ts";

export { IndicatorController, WIDGET_KEY } from "./runtime/controller.ts";

export default function subscriptionBurndownExtension(pi: ExtensionAPI): void {
  const controller = new IndicatorController();

  pi.on("session_start", async (_event, ctx) => {
    await controller.start(ctx);
  });
  pi.on("session_switch", async (_event, ctx) => {
    await controller.restart(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => {
    await controller.restart(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    controller.shutdown(ctx);
  });
  pi.on("after_provider_response", (event, ctx) => {
    controller.ingestResponse(event, ctx);
  });

  pi.registerCommand("burndown-status", {
    description: "Show subscription burndown source and freshness diagnostics",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) ctx.ui.notify(controller.status(), "info");
    },
  });
}
