"use strict";

const ALIAS = "gpt-daybreak-blue-latest";
const RED_ALIAS = "gpt-daybreak-red-latest";
const CATALOG_MARKER = "codexLinuxDaybreakCatalogVisibleAlias";
const PICKER_MARKER = "codexLinuxDaybreakPickerVisibleAlias";
const IDENT = "[A-Za-z_$][\\w$]*";

function replaceUnique(source, pattern, replacement, description) {
  if (typeof source !== "string") {
    return source;
  }
  const matches = [...source.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`))];
  if (matches.length !== 1) {
    console.warn(`WARN: Expected one ${description}, found ${matches.length}`);
    return source;
  }
  return source.replace(pattern, replacement);
}

function applyDaybreakCatalogVisibilityPatch(source) {
  if (typeof source !== "string" || source.includes(CATALOG_MARKER)) {
    return source;
  }
  const pattern = new RegExp(
    `(function ${IDENT}\\(\\{additionalAvailableModels:(${IDENT}),authMethod:(${IDENT}),` +
      `availableModels:(${IDENT}),hasConfiguredModelCatalog:(${IDENT}),` +
      `isCustomModelProvider:(${IDENT}),model:(${IDENT}),useHiddenModels:(${IDENT})\\}\\)\\{return )` +
      `(\\2\\?\\.has\\(\\7\\.model\\)===!0\\|\\|\\7\\.model!==\\\`codex-auto-review\\\`&&` +
      `\\(\\5&&!\\7\\.hidden\\|\\|\\(\\8&&!\\6&&\\3!==\\\`amazonBedrock\\\`` +
      `\\?\\4\\.has\\(\\7\\.model\\):!\\7\\.hidden\\)\\)\\})`,
  );
  return replaceUnique(
    source,
    pattern,
    (_match, prefix, _additional, authMethod, _available, _configured, _custom, model, _hidden, suffix) =>
      `${prefix}(${authMethod}===\`chatgpt\`||${authMethod}===\`chatgptAuthTokens\`)&&` +
      `${model}.model===\`${ALIAS}\`&&${model}.hidden===!1` +
      `/*${CATALOG_MARKER}*/||${suffix}`,
    "Daybreak catalog visibility helper",
  );
}

function applyDaybreakPickerVisibilityPatch(source) {
  if (typeof source !== "string" || source.includes(PICKER_MARKER)) {
    return source;
  }
  const pattern = new RegExp(
    `(function ${IDENT}\\((${IDENT}),(${IDENT}),${IDENT}=!1\\)\\{return \\2\\?\\.filter\\()` +
      `\\(\\{model:(${IDENT})\\}\\)=>\\3==null\\|\\|\\4!==\\\`${ALIAS}\\\`` +
      `(\\&\\&\\4!==\\\`${RED_ALIAS}\\\`)?` +
      `(\\)\\.map\\()`,
  );
  return replaceUnique(
    source,
    pattern,
    (_match, prefix, _models, _access, model, redAliasExclusion, suffix) =>
      `${prefix}({model:${model},hidden:codexLinuxDaybreakHidden})=>` +
      `(${model}!==\`${ALIAS}\`||` +
      `codexLinuxDaybreakHidden===!1/*${PICKER_MARKER}*/)${redAliasExclusion ?? ""}${suffix}`,
    "Daybreak picker visibility filter",
  );
}

function matchesCatalogContract(source) {
  return typeof source === "string" &&
    source.includes("additionalAvailableModels:") &&
    source.includes("hasConfiguredModelCatalog:") &&
    source.includes("`codex-auto-review`") &&
    source.includes("useHiddenModels:");
}

function matchesPickerContract(source) {
  return typeof source === "string" &&
    source.includes("composer.modelPicker.daybreak.modelDisabled") &&
    source.includes("composer.modelPicker.daybreak.modelUnavailable") &&
    source.includes("`gpt-daybreak-blue-latest`");
}

const descriptors = [
  {
    id: "daybreak-catalog-visible-alias",
    phase: "webview-asset",
    order: 20_551,
    ciPolicy: "optional",
    enforceWhenEnabled: true,
    pattern: /^app-initial-[^.]+\.js$/,
    assetMatch: matchesCatalogContract,
    missingDescription: "Daybreak model catalog visibility helper",
    skipDescription: "Daybreak catalog visible alias patch",
    apply: applyDaybreakCatalogVisibilityPatch,
  },
  {
    id: "daybreak-picker-visible-alias",
    phase: "webview-asset",
    order: 20_552,
    ciPolicy: "optional",
    enforceWhenEnabled: true,
    pattern: /^app-primary-[^.]+\.js$/,
    assetMatch: matchesPickerContract,
    missingDescription: "Daybreak model picker access filter",
    skipDescription: "Daybreak picker visible alias patch",
    apply: applyDaybreakPickerVisibilityPatch,
  },
];

module.exports = {
  applyDaybreakCatalogVisibilityPatch,
  applyDaybreakPickerVisibilityPatch,
  descriptors,
};
