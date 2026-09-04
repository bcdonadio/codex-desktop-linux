#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  applyWebviewAssetPatchDescriptors,
  normalizePatchDescriptors,
} = require("../../scripts/patches/engine.js");
const {
  captureWarnings,
  createPatchReport,
  enabledFeatureFailuresFromReport,
} = require("../../scripts/lib/patch-report.js");
const { loadLinuxFeaturePatchDescriptors } = require("../../scripts/lib/linux-features.js");
const { applyRealtimeVoiceSidebarPatch, descriptors } = require("./patch.js");

function footerFixture({ gate = "!1", capability = "e", callback = "t", gateAlias = "Qze" } = {}) {
  return [
    `function renderFooter(${capability},${callback},n){return ${capability}&&${callback}!=null&&${gateAlias}(n,\`2919110489\`).get(\`enabled\`,${gate})?{label:\`sidebar.voice.label\`,ariaLabel:\`sidebar.voice.startAriaLabel\`}:null}`,
    "function unrelatedStats(n){return Qze(n,`other-gate`).get(`enabled`,!1)}",
  ].join("");
}

function evaluateFooter(source, capability = true, callback = () => {}, storedGateEnabled = false) {
  const footer = Function("Qze", `${source};return renderFooter;`)((_scope, id) => ({
    get: (_name, fallback) => id === "2919110489" ? storedGateEnabled : fallback,
  }));
  return footer(capability, callback, {});
}

function withTempDir(callback) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "realtime-voice-sidebar-"));
  try {
    return callback(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function withFeatureConfig(enabled, callback) {
  return withTempDir((tempDir) => {
    const configPath = path.join(tempDir, "features.json");
    fs.writeFileSync(configPath, `${JSON.stringify({ enabled })}\n`);
    const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;
    process.env.CODEX_LINUX_FEATURES_CONFIG = configPath;
    try {
      return callback(path.resolve(__dirname, ".."));
    } finally {
      if (originalConfig == null) delete process.env.CODEX_LINUX_FEATURES_CONFIG;
      else process.env.CODEX_LINUX_FEATURES_CONFIG = originalConfig;
    }
  });
}

test("feature remains disabled until explicitly enabled", () => {
  withFeatureConfig([], (featuresRoot) => {
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot }), []);
  });
});

test("enabled feature loads one optional sidebar-entrypoint descriptor", () => {
  withFeatureConfig(["realtime-voice-sidebar"], (featuresRoot) => {
    const loaded = loadLinuxFeaturePatchDescriptors({ featuresRoot });
    assert.deepEqual(
      loaded.map((descriptor) => [descriptor.id, descriptor.phase, descriptor.ciPolicy]),
      [["feature:realtime-voice-sidebar:sidebar-entrypoint", "webview-asset", "optional"]],
    );
  });
});

test("manifest has no dependencies, resources, or hooks and descriptor targets only app-primary assets", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "feature.json"), "utf8"));
  assert.equal(manifest.id, "realtime-voice-sidebar");
  assert.equal(manifest.defaultEnabled, false);
  assert.deepEqual(manifest.requires ?? [], []);
  assert.deepEqual(manifest.resources ?? [], []);
  assert.deepEqual(manifest.runtimeHooks ?? {}, {});
  assert.deepEqual(
    descriptors.map((descriptor) => [descriptor.id, descriptor.phase, descriptor.ciPolicy]),
    [["sidebar-entrypoint", "webview-asset", "optional"]],
  );
  assert.equal(descriptors[0].pattern.test("app-primary-ABC123.js"), true);
  assert.equal(descriptors[0].pattern.test("app-primary-foo.bar.js"), false);
  assert.equal(descriptors[0].pattern.test("app-initial-ABC123.js"), false);
  assert.equal(descriptors[0].pattern.test("settings-page-ABC123.js"), false);
});

test("false gate suppresses Voice and true gate exposes the Voice branch after patching", () => {
  const source = footerFixture();
  assert.equal(evaluateFooter(source), null);
  const patched = applyRealtimeVoiceSidebarPatch(source);
  assert.notEqual(patched, source);
  assert.doesNotMatch(patched, /Qze\(n,`2919110489`\)\.get\(`enabled`,/);
  assert.match(patched, /&&!0\/\*codexLinuxRealtimeVoiceSidebarGate\*\/\?/);
  assert.deepEqual(evaluateFooter(patched, true, () => {}, false), {
    label: "sidebar.voice.label",
    ariaLabel: "sidebar.voice.startAriaLabel",
  });
});

test("capability false and null callback still suppress Voice after patching", () => {
  const patched = applyRealtimeVoiceSidebarPatch(footerFixture());
  assert.equal(evaluateFooter(patched, false), null);
  assert.equal(evaluateFooter(patched, true, null), null);
});

test("patch is idempotent and preserves unrelated Statsig calls", () => {
  const source = footerFixture();
  const once = applyRealtimeVoiceSidebarPatch(source);
  assert.equal(applyRealtimeVoiceSidebarPatch(once), once);
  assert.match(once, /function unrelatedStats\(n\)\{return Qze\(n,`other-gate`\)\.get\(`enabled`,!1\)\}/);
  assert.equal((once.match(/codexLinuxRealtimeVoiceSidebarGate/g) ?? []).length, 1);
});

test("alias drift and decoy gate literals fail closed", () => {
  const aliasDrift = footerFixture({ gateAlias: "Qzf" });
  const decoy = `${footerFixture({ gateAlias: "Qzf" })}function decoy(n){return Qze(n,\`2919110489\`).get(\`enabled\`,!1)}`;
  for (const source of [aliasDrift, decoy]) {
    const result = captureWarnings(() => applyRealtimeVoiceSidebarPatch(source));
    assert.equal(result.value, source);
    assert.ok(result.warnings.some((warning) => /realtime voice sidebar/i.test(warning)));
  }
});

test("missing, duplicate, changed, partial, and mixed contracts fail closed", () => {
  const complete = footerFixture();
  const cases = [
    "function renderFooter(e,t,n){return null}",
    complete.replace("Qze(n,`2919110489`).get(`enabled`,!1)", "Qze(n,`2919110489`).get(`enabled`,!0)"),
    `${complete}${complete}`,
    complete.replace("sidebar.voice.label", "sidebar.voice.title"),
    `${footerFixture({ gateAlias: "Qzf" })}function another(e,t,n){let r=Qze(n,\`2919110489\`).get(\`enabled\`,!1);return e&&t!=null&&r?\`sidebar.voice.label\`:null}`,
  ];
  for (const source of cases) {
    const result = captureWarnings(() => applyRealtimeVoiceSidebarPatch(source));
    assert.equal(result.value, source);
    assert.ok(result.warnings.some((warning) => /realtime voice sidebar/i.test(warning)));
  }
});

test("already-patched contract is accepted only when it is the sole valid contract", () => {
  const patched = applyRealtimeVoiceSidebarPatch(footerFixture());
  assert.equal(applyRealtimeVoiceSidebarPatch(patched), patched);
  const mixed = `${patched}${footerFixture()}`;
  const result = captureWarnings(() => applyRealtimeVoiceSidebarPatch(mixed));
  assert.equal(result.value, mixed);
  assert.ok(result.warnings.some((warning) => /realtime voice sidebar/i.test(warning)));
});

test("enabled descriptor patches a temporary extracted app and records the feature report entry", () => {
  withFeatureConfig(["realtime-voice-sidebar"], (featuresRoot) => {
    withTempDir((extractedDir) => {
      const assetsDir = path.join(extractedDir, "webview", "assets");
      fs.mkdirSync(assetsDir, { recursive: true });
      const target = path.join(assetsDir, "app-primary-ABC123.js");
      const untouched = path.join(assetsDir, "app-initial-ABC123.js");
      fs.writeFileSync(target, footerFixture());
      fs.writeFileSync(untouched, footerFixture());

      const report = createPatchReport();
      report.enabledFeatures = ["realtime-voice-sidebar"];
      const loaded = normalizePatchDescriptors(loadLinuxFeaturePatchDescriptors({ featuresRoot }));
      applyWebviewAssetPatchDescriptors(extractedDir, loaded, {}, report);

      assert.match(fs.readFileSync(target, "utf8"), /codexLinuxRealtimeVoiceSidebarGate/);
      assert.equal(fs.readFileSync(untouched, "utf8"), footerFixture());
      assert.deepEqual(enabledFeatureFailuresFromReport(report), []);
      assert.deepEqual(
        report.patches.map((patch) => [patch.name, patch.status, patch.featureId]),
        [["feature:realtime-voice-sidebar:sidebar-entrypoint", "applied", "realtime-voice-sidebar"]],
      );
    });
  });
});
