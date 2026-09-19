#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { loadLinuxFeaturePatchDescriptors } = require("../../scripts/lib/linux-features.js");

const {
  applyDaybreakCatalogVisibilityPatch,
  applyDaybreakPickerVisibilityPatch,
  descriptors,
} = require("./patch.js");

function catalogFixture() {
  return "function L9n({additionalAvailableModels:e,authMethod:t,availableModels:n,hasConfiguredModelCatalog:r,isCustomModelProvider:i,model:a,useHiddenModels:o}){return e?.has(a.model)===!0||a.model!==`codex-auto-review`&&(r&&!a.hidden||(o&&!i&&t!==`amazonBedrock`?n.has(a.model):!a.hidden))}";
}

function pickerFixture() {
  return "function c3(e,t,n=!1){return e?.filter(({model:e})=>t==null||e!==`gpt-daybreak-blue-latest`).map(e=>{let r=null;return(t===!1?!Oae(e,!1):t===`standard`&&Ase(e.model))?r=mr({id:`disabled`}):(typeof t==`boolean`?t&&!Oae(e,!0):t!=null&&qee(e.model,t,n))&&(r=mr({id:`unavailable`})),{model:e,disabledReason:r}})}";
}

function evaluateCatalog(source, authMethod, model, availableModels = new Set()) {
  const visible = Function(`${source};return L9n;`)();
  return visible({
    additionalAvailableModels: null,
    authMethod,
    availableModels,
    hasConfiguredModelCatalog: false,
    isCustomModelProvider: false,
    model,
    useHiddenModels: true,
  });
}

function evaluatePicker(source, models, access) {
  const picker = Function(
    "Oae",
    "Ase",
    "qee",
    "mr",
    `${source};return c3;`,
  )(
    (model, enabled) => {
      const programs = model.availableAccessPrograms?.cyber;
      return (!enabled && !programs?.length) || (enabled
        ? programs?.includes("daybreakBlue") || programs?.includes("daybreakRed")
        : programs?.includes("standard")) === true;
    },
    (model) => model.toLowerCase().includes("cyber") || model.toLowerCase().includes("daybreak-red"),
    (model, program) => program !== "standard" && (model === "gpt-6-astra" || model === "gpt-6-astra-wm"),
    (message) => message,
  );
  return picker(models, access).map(({ model, disabledReason }) => ({
    disabledReason,
    model: model.model,
  }));
}

test("descriptors target the two current official bundle roles", () => {
  assert.deepEqual(
    descriptors.map(({ id, phase, ciPolicy, enforceWhenEnabled, pattern }) => [
      id,
      phase,
      ciPolicy,
      enforceWhenEnabled,
      pattern.test("app-initial-current.js"),
      pattern.test("app-primary-current.js"),
      typeof descriptors.find((candidate) => candidate.id === id)?.assetMatch,
    ]),
    [
      ["daybreak-catalog-visible-alias", "webview-asset", "optional", true, true, false, "function"],
      ["daybreak-picker-visible-alias", "webview-asset", "optional", true, false, true, "function"],
    ],
  );
});

test("feature stays disabled until explicitly listed", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "daybreak-model-visibility-"));
  const config = path.join(directory, "features.json");
  const previous = process.env.CODEX_LINUX_FEATURES_CONFIG;
  try {
    fs.writeFileSync(config, '{"enabled":[]}\n');
    process.env.CODEX_LINUX_FEATURES_CONFIG = config;
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot: path.resolve(__dirname, "..") }), []);
    fs.writeFileSync(config, '{"enabled":["daybreak-model-visibility"]}\n');
    assert.deepEqual(
      loadLinuxFeaturePatchDescriptors({ featuresRoot: path.resolve(__dirname, "..") }).map(({ id }) => id),
      [
        "feature:daybreak-model-visibility:daybreak-catalog-visible-alias",
        "feature:daybreak-model-visibility:daybreak-picker-visible-alias",
      ],
    );
  } finally {
    previous == null ? delete process.env.CODEX_LINUX_FEATURES_CONFIG : process.env.CODEX_LINUX_FEATURES_CONFIG = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("catalog admits only a visible Daybreak alias for ChatGPT authentication", () => {
  const patched = applyDaybreakCatalogVisibilityPatch(catalogFixture());
  const visibleAlias = { model: "gpt-daybreak-blue-latest", hidden: false };
  const hiddenAlias = { model: "gpt-daybreak-blue-latest", hidden: true };
  const missingVisibility = { model: "gpt-daybreak-blue-latest" };
  const ordinary = { model: "gpt-6-astra", hidden: false };

  assert.equal(evaluateCatalog(patched, "chatgpt", visibleAlias), true);
  assert.equal(evaluateCatalog(patched, "chatgptAuthTokens", visibleAlias), true);
  assert.equal(evaluateCatalog(patched, "apikey", visibleAlias), false);
  assert.equal(evaluateCatalog(patched, "copilot", visibleAlias), false);
  assert.equal(evaluateCatalog(patched, "chatgpt", hiddenAlias), false);
  assert.equal(evaluateCatalog(patched, "chatgpt", missingVisibility), false);
  assert.equal(evaluateCatalog(patched, "chatgpt", ordinary), false);
  assert.equal(evaluateCatalog(patched, "chatgpt", ordinary, new Set([ordinary.model])), true);
});

test("picker retains only a visible Daybreak alias and preserves access metadata checks", () => {
  const patched = applyDaybreakPickerVisibilityPatch(pickerFixture());
  const models = [
    { model: "gpt-daybreak-blue-latest", hidden: false, availableAccessPrograms: { cyber: ["daybreakBlue"] } },
    { model: "gpt-daybreak-blue-latest", hidden: true, availableAccessPrograms: { cyber: ["daybreakBlue"] } },
    { model: "gpt-daybreak-blue-latest" },
    { model: "gpt-6-astra", hidden: false, availableAccessPrograms: { cyber: ["standard"] } },
  ];

  assert.deepEqual(evaluatePicker(patched, models, "daybreakBlue"), [
    { model: "gpt-daybreak-blue-latest", disabledReason: null },
    { model: "gpt-6-astra", disabledReason: { id: "unavailable" } },
  ]);
  assert.deepEqual(evaluatePicker(patched, models, null).map(({ model }) => model), [
    "gpt-daybreak-blue-latest",
    "gpt-6-astra",
  ]);
});

test("patches are idempotent and fail closed on missing or ambiguous contracts", () => {
  for (const [apply, fixture] of [
    [applyDaybreakCatalogVisibilityPatch, catalogFixture],
    [applyDaybreakPickerVisibilityPatch, pickerFixture],
  ]) {
    const source = fixture();
    const patched = apply(source);
    assert.notEqual(patched, source);
    assert.equal(apply(patched), patched);
    assert.equal(apply("function unrelated(){return!0}"), "function unrelated(){return!0}");
    assert.equal(apply(source + source), source + source);
  }
});

test("patches match an optionally supplied extracted official bundle", (t) => {
  const assets = process.env.DAYBREAK_MODEL_VISIBILITY_OFFICIAL_ASSETS;
  if (assets == null) {
    t.skip("DAYBREAK_MODEL_VISIBILITY_OFFICIAL_ASSETS is not set");
    return;
  }
  const names = fs.readdirSync(assets);
  const initialNames = names.filter((name) => /^app-initial-[^.]+\.js$/.test(name));
  const primaryNames = names.filter((name) => /^app-primary-[^.]+\.js$/.test(name));
  assert.equal(initialNames.length, 1);
  assert.equal(primaryNames.length, 1);
  const initial = fs.readFileSync(path.join(assets, initialNames[0]), "utf8");
  const primary = fs.readFileSync(path.join(assets, primaryNames[0]), "utf8");

  assert.notEqual(applyDaybreakCatalogVisibilityPatch(initial), initial);
  assert.notEqual(applyDaybreakPickerVisibilityPatch(primary), primary);
});

// Reproduce the live model/list response: visible alias, no cyber metadata.
test("live legacy catalog survives both filters with Daybreak off", () => {
  const models = [{ model: "gpt-daybreak-blue-latest", hidden: false }];
  const catalog = applyDaybreakCatalogVisibilityPatch(catalogFixture());
  const picker = applyDaybreakPickerVisibilityPatch(pickerFixture());
  const visible = models.filter(model => evaluateCatalog(catalog, "chatgpt", model));
  assert.deepEqual(evaluatePicker(picker, visible, false), [
    { model: "gpt-daybreak-blue-latest", disabledReason: null },
  ]);
  assert.deepEqual(evaluatePicker(picker, [], false), []);
  assert.equal(evaluatePicker(picker, models, true)[0].disabledReason.id, "unavailable");
  assert.equal(evaluatePicker(picker, [{...models[0], availableAccessPrograms: {cyber: ["daybreakBlue"]}}], false)[0].disabledReason.id, "disabled");
});
