import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  AccountLabelsMode,
  DensityMode,
  DisplaySettings,
  ExhaustedDisplayMode,
  ExhaustedLabelMode,
  LayoutMode,
} from "./config.ts";

const DISPLAY_KEYS = [
  "density",
  "layout",
  "accountLabels",
  "exhaustedDisplay",
  "exhaustedLabel",
  "providerLabelMaxColumns",
] as const;
type DisplayKey = (typeof DISPLAY_KEYS)[number];

export const defaultSettingsPath = (): string =>
  join(process.env.HOME?.trim() || homedir(), ".omp", "agent", "burndown.yml");

function validate(settings: DisplaySettings): DisplaySettings {
  const density = settings.density;
  if (density !== undefined && density !== "dense" && density !== "text") {
    throw new Error("density must be dense or text");
  }
  const layout = settings.layout;
  if (layout !== undefined && layout !== "fit" && layout !== "wrap") {
    throw new Error("layout must be fit or wrap");
  }
  const accountLabels = settings.accountLabels;
  if (
    accountLabels !== undefined &&
    accountLabels !== "full" &&
    accountLabels !== "masked" &&
    accountLabels !== "provider-only"
  ) {
    throw new Error("accountLabels must be full, masked, or provider-only");
  }
  const exhaustedDisplay = settings.exhaustedDisplay;
  if (
    exhaustedDisplay !== undefined &&
    exhaustedDisplay !== "status" &&
    exhaustedDisplay !== "reset"
  ) {
    throw new Error("exhaustedDisplay must be status or reset");
  }
  const exhaustedLabel = settings.exhaustedLabel;
  if (exhaustedLabel !== undefined && exhaustedLabel !== "full" && exhaustedLabel !== "symbol") {
    throw new Error("exhaustedLabel must be full or symbol");
  }
  const providerLabelMaxColumns = settings.providerLabelMaxColumns;
  if (
    providerLabelMaxColumns !== undefined &&
    (!Number.isInteger(providerLabelMaxColumns) ||
      (typeof providerLabelMaxColumns === "number" &&
        (providerLabelMaxColumns < 0 || providerLabelMaxColumns > 256)))
  ) {
    throw new Error("providerLabelMaxColumns must be an integer from 0 through 256");
  }
  return settings;
}

function parse(text: string): DisplaySettings {
  const settings: DisplaySettings = {};
  for (const line of text.split(/\r?\n/)) {
    const match =
      /^(density|layout|accountLabels|exhaustedDisplay|exhaustedLabel|providerLabelMaxColumns):\s*(\S+)\s*$/.exec(
        line,
      );
    if (!match) continue;
    const [key, value] = match.slice(1) as [DisplayKey, string];
    settings[key] = (key === "providerLabelMaxColumns" ? Number(value) : value) as never;
  }
  return validate(settings);
}

function serialize(settings: Required<DisplaySettings>): string {
  return DISPLAY_KEYS.map((key) => `${key}: ${settings[key]}\n`).join("");
}

export async function loadDisplaySettings(path = defaultSettingsPath()): Promise<DisplaySettings> {
  try {
    return parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function updateDisplaySettings(
  path: string,
  changes: DisplaySettings,
): Promise<Required<DisplaySettings>> {
  validate(changes);
  const current = await loadDisplaySettings(path);
  const updated = {
    density: "dense" as DensityMode,
    layout: "fit" as LayoutMode,
    accountLabels: "full" as AccountLabelsMode,
    exhaustedDisplay: "status" as ExhaustedDisplayMode,
    exhaustedLabel: "full" as ExhaustedLabelMode,
    providerLabelMaxColumns: 0,
    ...current,
    ...changes,
  };
  validate(updated);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, serialize(updated), "utf8");
  await rename(temporary, path);
  return updated;
}
