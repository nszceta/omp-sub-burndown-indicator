import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDisplaySettings, updateDisplaySettings } from "../src/settings.ts";

const settingsFile = "burndown.yml";

async function withTemporarySettings(
  run: (path: string, directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "omp-sub-burndown-settings-"));
  try {
    await run(join(directory, settingsFile), directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("loads a missing settings file as empty display settings", async () => {
  await withTemporarySettings(async (path) => {
    expect(await loadDisplaySettings(path)).toEqual({});
  });
});

test("rejects invalid display modes from persisted YAML", async () => {
  const invalidModes = [
    ["density", "compact"],
    ["layout", "columns"],
    ["accountLabels", "hidden"],
    ["exhaustedDisplay", "countdown"],
    ["providerLabelMaxColumns", "-1"],
    ["providerLabelMaxColumns", "eight"],
  ] as const;

  for (const [key, value] of invalidModes) {
    await withTemporarySettings(async (path) => {
      await writeFile(path, `${key}: ${value}\n`, "utf8");
      await expect(loadDisplaySettings(path)).rejects.toThrow(key);
    });
  }
});

test("rejects an invalid update without changing the existing file", async () => {
  await withTemporarySettings(async (path) => {
    const original =
      "density: dense\nlayout: fit\naccountLabels: full\nexhaustedDisplay: status\nproviderLabelMaxColumns: 0\n";
    await writeFile(path, original, "utf8");

    await expect(updateDisplaySettings(path, { density: "compact" } as never)).rejects.toThrow(
      "density",
    );
    expect(await readFile(path, "utf8")).toBe(original);
  });
});

test("atomically persists a merged update", async () => {
  await withTemporarySettings(async (path, directory) => {
    await writeFile(
      path,
      "density: dense\nlayout: fit\naccountLabels: full\nexhaustedDisplay: status\nexhaustedLabel: full\nproviderLabelMaxColumns: 0\n",
    );

    const updated = await updateDisplaySettings(path, {
      accountLabels: "masked",
      exhaustedDisplay: "reset",
      providerLabelMaxColumns: 8,
    });

    expect(updated).toEqual({
      density: "dense",
      layout: "fit",
      accountLabels: "masked",
      exhaustedDisplay: "reset",
      exhaustedLabel: "full",
      providerLabelMaxColumns: 8,
    });
    expect(await loadDisplaySettings(path)).toEqual(updated);
    expect(await readdir(directory)).toEqual([settingsFile]);
  });
});

test("round-trips all six display keys", async () => {
  await withTemporarySettings(async (path) => {
    const expected = {
      density: "text",
      layout: "wrap",
      accountLabels: "provider-only",
      exhaustedDisplay: "reset",
      exhaustedLabel: "symbol",
      providerLabelMaxColumns: 8,
    } as const;

    await updateDisplaySettings(path, expected);
    expect(await loadDisplaySettings(path)).toEqual(expected);
  });
});
