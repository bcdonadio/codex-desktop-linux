"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const manifest = require("./feature.json");
const descriptors = require("./patch.js");
const {
  applyAutomationPluginEnablePatch,
  applyAutomationUpdateEagerToolPatch,
  matchesAutomationUpdateEagerToolContract,
} = require("./eager-update.js");
const {
  applyObservableAutomationViewPatch,
  matchesObservableAutomationViewContract,
} = require("./observable-view.js");

function automationViewFixture(hostClass = null) {
  return [
    '"use strict";',
    "const store=new Map([[`existing`,{id:`existing`,kind:`heartbeat`,name:`Acceptance`,prompt:`Report marker`,rrule:`FREQ=WEEKLY;BYDAY=SU;BYHOUR=23;BYMINUTE=59`,status:`PAUSED`}]]);",
    "const api={kr:e=>store.get(e)??null,Or:e=>store.delete(e)?`deleted`:`not_found`};",
    "function Oz(e){return{contentItems:[{type:`inputText`,text:e==null?`Rendered automation card in the app.`:e.mode===`create`?`Created automation in the app.`:e.mode===`update`?`Updated automation in the app.`:e.deleteStatus===`not_found`?`Automation already does not exist in the app.`:`Deleted automation in the app.`},...e==null?[]:[{type:`inputText`,text:JSON.stringify(e)}]],success:!0}}",
    "function Mz(e){return{response:{contentItems:[{type:`inputText`,text:e}],success:!1}}}",
    "async function jz(e,{threadId:t,argumentsValue:n},r){let i={success:!0,data:n};if(!i.success)return Mz(`invalid`);let a=i.data;if(a.mode===`delete`){let t=a.id??``;try{let{item:n,status:r,success:i}=await e.delete({id:t});return{response:i?Oz({automationId:t,mode:`delete`,deleteStatus:r===`not_found`?`not_found`:`deleted`,snapshot:n==null?null:{kind:n.kind,name:n.name,rrule:n.rrule}}):Mz(`failed`).response,mutation:{mode:`delete`,id:t,item:n,status:r}}}catch(e){return{...Mz(`failed`),mutation:{mode:`delete`,id:t,item:null,status:`host_error`}}}}return{response:Oz()}}",
    hostClass ?? "var Fz=class{async delete({id:e}){let t=api.kr(e),r=api.Or(e),i=r===`deleted`||r===`not_found`;return{item:t,success:i,status:r}}executeUpdateTool(e){return e.hostId===`local`?jz(this,e,e=>null):null}};",
    "globalThis.run=async id=>(await jz(new Fz,{threadId:`thread`,argumentsValue:{mode:`view`,id}},()=>null)).response;",
  ].join("");
}

test("automation-extensions is disabled by default and owns all optional patches", () => {
  assert.equal(manifest.defaultEnabled, false);
  assert.deepEqual(
    descriptors.map(({ id }) => id),
    [
      "multi-time-rrule",
      "eager-automation-update",
      "automation-plugin-pipe",
      "observable-automation-view",
      "automation-plugin-enable",
    ],
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
    "const pluginKey=`plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled_tools`,legacyKey=`mcp_servers.codex_app.enabled_tools`;",
    "function key(version){return version?pluginKey:legacyKey}",
    "function catalog(){return[automation].map(e=>({type:`function`,...e,...E&&(!YBl.has(e.name)||BBl.includes(e.name))?{deferLoading:!0}:{}}))}",
    "async function build(local,usePlugin){let result={config:{unrelated:7}},n=catalog(),client={getAppServerVersion:()=>usePlugin},inputs={usesDesktopMcp:local};inputs.usesDesktopMcp&&(result.config={...result.config,[key(client.getAppServerVersion())]:n.flatMap(e=>e.type===`namespace`?e.tools.map(({name:e})=>e):[e.name])});return result.config}",
    "globalThis.build=build;",
  ].join(";");

  const patched = descriptors
    .filter(({ phase }) => phase === "webview-asset")
    .reduce((current, descriptor) => descriptor.apply(current), source);
  const context = vm.createContext({});
  vm.runInContext(patched, context);

  const localConfig = await context.build(true, true);
  assert.equal(localConfig.unrelated, 7);
  assert.deepEqual(
    Array.from(localConfig["plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled_tools"]),
    ["automation_update"],
  );
  assert.equal(
    localConfig["plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled"],
    true,
  );
  const legacyConfig = await context.build(true, false);
  assert.deepEqual(Array.from(legacyConfig["mcp_servers.codex_app.enabled_tools"]), ["automation_update"]);
  assert.equal(legacyConfig["mcp_servers.codex_app.enabled"], true);
  assert.deepEqual(Object.keys(await context.build(false, true)), ["unrelated"]);
  assert.equal(applyAutomationPluginEnablePatch(patched), patched);
});

test("automation plugin enablement rejects an unexpected enabled-tools key contract", () => {
  const source = [
    "const pluginKey=`plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.tools`,legacyKey=`mcp_servers.codex_app.tools`;",
    "function key(version){return version?pluginKey:legacyKey}",
    "async function build(local){let result={config:{}},n=[],client={getAppServerVersion:()=>!0},inputs={usesDesktopMcp:local};inputs.usesDesktopMcp&&(result.config={...result.config,[key(client.getAppServerVersion())]:n.flatMap(e=>e.type===`namespace`?e.tools.map(({name:e})=>e):[e.name])});return result.config}",
  ].join(";");

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(applyAutomationPluginEnablePatch(source), source);
  } finally {
    console.warn = originalWarn;
  }
});

test("adopted app servers receive the Desktop automation pipe explicitly", async () => {
  const source = [
    "const process={env:{CODEX_APP_TOOLS_PIPE_PATH:`/tmp/codex-app-tools.sock`},resourcesPath:`/resources`};",
    "const base={mcpServers:{codex_app:{command:`launch`,env:{BASE:`preserved`}}}};",
    "function unavailable(reason){return null}",
    "async function Co({hostConfig:e,resourcesPath:t=process.resourcesPath}){if(!process.env.CODEX_APP_TOOLS_PIPE_PATH)return unavailable(`missing-pipe`);let r=!1,i=base,a=null,{mcpServers:{codex_app:s}}=i,c={...s.env},l=null;return{...s,command:s.command,cwd:`/plugin`,enabled:!1,env:c}}",
    "globalThis.read=Co;",
  ].join("");
  const descriptor = descriptors.find(({ id }) => id === "automation-plugin-pipe");

  assert.ok(descriptor);
  const patched = descriptor.apply(source);
  const context = vm.createContext({});
  vm.runInContext(patched, context);

  const config = await context.read({ hostConfig: { kind: "local" } });
  assert.equal(config.env.BASE, "preserved");
  assert.equal(config.env.CODEX_APP_TOOLS_PIPE_PATH, "/tmp/codex-app-tools.sock");
  assert.equal(descriptor.apply(patched), patched);
  assert.throws(
    () => descriptor.apply(patched + "const decoy=`codexLinuxForwardAutomationPipe`;"),
    /did not match the current bundle exactly once/,
  );
});

test("automation pipe forwarding fails closed on drift and incomplete markers", () => {
  const descriptor = descriptors.find(({ id }) => id === "automation-plugin-pipe");

  assert.ok(descriptor);
  assert.throws(
    () => descriptor.apply("const changed=`native app tools transport removed`;"),
    /did not match the current bundle exactly once/,
  );
  assert.throws(
    () => descriptor.apply("const marker=`codexLinuxForwardAutomationPipe`;"),
    /did not match the current bundle exactly once/,
  );
});

test("automation view returns machine-readable status and absence", async () => {
  const source = automationViewFixture();

  const patched = descriptors
    .filter(({ id }) => id === "observable-automation-view")
    .reduce((current, descriptor) => descriptor.apply(current), source);
  assert.equal(matchesObservableAutomationViewContract(patched), true);
  assert.equal(applyObservableAutomationViewPatch(patched), patched);
  const context = vm.createContext({});
  vm.runInContext(patched, context);

  const foundResponse = await context.run("existing");
  assert.equal(foundResponse.contentItems[0].text, "Read automation from the app.");
  assert.deepEqual(JSON.parse(foundResponse.contentItems[1].text), {
    automationId: "existing",
    mode: "view",
    viewStatus: "found",
    status: "PAUSED",
    snapshot: {
      kind: "heartbeat",
      name: "Acceptance",
      prompt: "Report marker",
      rrule: "FREQ=WEEKLY;BYDAY=SU;BYHOUR=23;BYMINUTE=59",
      status: "PAUSED",
    },
  });

  const missingResponse = await context.run("missing");
  assert.equal(missingResponse.contentItems[0].text, "Automation does not exist in the app.");
  assert.deepEqual(JSON.parse(missingResponse.contentItems[1].text), {
    automationId: "missing",
    mode: "view",
    viewStatus: "not_found",
    status: null,
    snapshot: null,
  });
});

test("automation view patch fails closed on drift and incomplete markers", () => {
  assert.throws(
    () => applyObservableAutomationViewPatch("const changed=`Automation card copy changed`;"),
    /did not match the current or patched bundle/,
  );
  assert.throws(
    () => applyObservableAutomationViewPatch("const marker=`codexLinuxObservableAutomationView`;"),
    /did not match the current or patched bundle/,
  );
  const partial = automationViewFixture().replace(
    "return{response:Oz()}",
    "return{response:Oz()}/*codexLinuxObservableAutomationView*/",
  );
  assert.throws(
    () => applyObservableAutomationViewPatch(partial),
    /Observable automation view/,
  );

  const patched = applyObservableAutomationViewPatch(automationViewFixture());
  const corruptions = [
    ["automationId:codexLinuxAutomationViewId,", ""],
    ["mode:`view`,viewStatus:", "viewStatus:"],
    ["prompt:codexLinuxAutomationViewItem.prompt,", ""],
    [
      "[{type:`inputText`,text:`Failed to view automation.`}],success:!1",
      "[{type:`inputText`,text:`Failed to view automation.`}],success:!0",
    ],
  ];
  for (const [needle, replacement] of corruptions) {
    assert.equal(patched.includes(needle), true);
    const corrupted = patched.replace(needle, replacement);
    assert.equal(matchesObservableAutomationViewContract(corrupted), false);
    assert.throws(
      () => applyObservableAutomationViewPatch(corrupted),
      /did not match the current or patched bundle/,
    );
  }
});

test("automation view patch rejects an unrelated matching store class", () => {
  const mismatchedHost = automationViewFixture(
    "var ActualHost=class{executeUpdateTool(e){return e.hostId===`local`?jz(this,e,e=>null):null}};" +
      "var Decoy=class{async delete({id:e}){let t=api.kr(e),r=api.Or(e),i=r===`deleted`||r===`not_found`;return{item:t,success:i,status:r}}};" +
      "var Fz=ActualHost;",
  );
  assert.throws(
    () => applyObservableAutomationViewPatch(mismatchedHost),
    /did not match the current or patched bundle/,
  );
});
