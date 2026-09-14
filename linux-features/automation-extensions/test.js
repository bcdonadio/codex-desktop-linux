"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const manifest = require("./feature.json");
const descriptors = require("./patch.js");
const {
  applyAutomationUpdateEagerToolPatch,
  matchesAutomationUpdateEagerToolContract,
} = require("./eager-update.js");

test("automation-extensions is disabled by default and owns both optional patches", () => {
  assert.equal(manifest.defaultEnabled, false);
  assert.deepEqual(
    descriptors.map(({ id }) => id),
    ["multi-time-rrule", "eager-automation-update", "automation-plugin-enable"],
  );
  assert.ok(descriptors.every(({ ciPolicy }) => ciPolicy === "optional"));
});

test("automation_update remains eager in the current dynamic tool catalog", () => {
  const source = "const tools=[automation].map(e=>({type:`function`,...e,...E&&(!YBl.has(e.name)||BBl.includes(e.name))?{deferLoading:!0}:{}}));";
  assert.equal(matchesAutomationUpdateEagerToolContract(source), true);
  const patched = applyAutomationUpdateEagerToolPatch(source);
  assert.notEqual(patched, source);
  assert.match(patched, /e\.name!==`automation_update`&&E&&\(!YBl\.has\(e\.name\)\|\|BBl\.includes\(e\.name\)\)/);
  assert.equal(applyAutomationUpdateEagerToolPatch(patched), patched);
});

test("local Desktop threads enable the plugin transport that owns automation_update", async () => {
  const source = [
    "const automation={name:`automation_update`},E=!0,YBl=new Set,BBl=[];",
    "function key(){return `plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled_tools`}",
    "function catalog(){return[automation].map(e=>({type:`function`,...e,...E&&(!YBl.has(e.name)||BBl.includes(e.name))?{deferLoading:!0}:{}}))}",
    "async function build(local){let result={config:{}},n=catalog(),client={getAppServerVersion:()=>`0.154.0`},inputs={usesDesktopMcp:local};inputs.usesDesktopMcp&&(result.config={...result.config,[key(client.getAppServerVersion())]:n.flatMap(e=>e.type===`namespace`?e.tools.map(({name:e})=>e):[e.name])});return result.config}",
    "globalThis.build=build;",
  ].join(";");

  const patched = descriptors
    .filter(({ phase }) => phase === "webview-asset")
    .reduce((current, descriptor) => descriptor.apply(current), source);
  const context = vm.createContext({});
  vm.runInContext(patched, context);

  const localConfig = await context.build(true);
  assert.deepEqual(
    Array.from(localConfig["plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled_tools"]),
    ["automation_update"],
  );
  assert.equal(
    localConfig["plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled"],
    true,
  );
  assert.deepEqual(Object.keys(await context.build(false)), []);
});
