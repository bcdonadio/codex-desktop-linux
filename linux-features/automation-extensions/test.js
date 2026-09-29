"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const manifest = require("./feature.json");
const descriptors = require("./patch.js");
const {
  applyAutomationScheduleMultiTimePatch,
} = require("../../scripts/patches/impl/automation-schedule.js");
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
    hostClass ?? "var Fz=class{habitatAutomationsService;async delete({id:e}){return this.#n(e,null)}async#n(e,t){t?.assertCurrent();let{item:r,status:i}=this.habitatAutomationsService?await this.habitatAutomationsService.delete(e):{item:api.kr(e),status:api.Or(e)},a=i===`deleted`||i===`not_found`;return{item:r,success:a,status:i}}executeUpdateTool(e){return this.#r(e,this)}#r(e,t){return e.hostId===`local`?this.habitatAutomationsService?.isLocalMigrationActive()?Promise.resolve({response:{success:!1,contentItems:[{type:`inputText`,text:`Local automation changes must use the Automations app after migration consent.`}]}}):jz(t,e,e=>null):null}};",
    "globalThis.run=async id=>(await jz(new Fz,{threadId:`thread`,argumentsValue:{mode:`view`,id}},()=>null)).response;",
    "globalThis.runViaHost=async(id,migrating)=>{let host=new Fz;host.habitatAutomationsService={isLocalMigrationActive:()=>migrating};return(await host.executeUpdateTool({hostId:`local`,threadId:`thread`,argumentsValue:{mode:`view`,id}})).response};",
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
    "async function build(local,usePlugin){let result={config:{unrelated:7}},n=catalog(),tools=n.flatMap(e=>e.type===`namespace`?e.tools:[e]),client={getAppServerVersion:()=>usePlugin},inputs={usesDesktopMcp:local};inputs.usesDesktopMcp&&(result.config={...result.config,[key(client.getAppServerVersion())]:tools.map(({name:e})=>e)});return result.config}",
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

test("current shared bundle selects the local Desktop MCP plugin config owner", async () => {
  const source = [
    "const pluginKey=`plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled_tools`,legacyKey=`mcp_servers.codex_app.enabled_tools`;",
    "function Kut(version){return version?pluginKey:legacyKey}",
    "async function build(local,usePlugin){let config={config:{unrelated:7}},n=[{type:`namespace`,tools:[{name:`automation_update`}]}],i=n.flatMap(e=>e.type===`namespace`?e.tools:[e]),client={getAppServerVersion:()=>usePlugin},inputs={usesDesktopMcp:local};inputs.usesDesktopMcp&&(config.config={...config.config,[Kut(client.getAppServerVersion())]:i.map(({name:e})=>e)});return config.config}",
    "globalThis.build=build;",
  ].join(";");
  const descriptor = descriptors.find(({ id }) => id === "automation-plugin-enable");
  assert.equal(descriptor.pattern.test("app-shared-current.js"), true);
  assert.equal(descriptor.pattern.test("app-initial-current.js"), false);
  assert.equal(descriptor.assetMatch(source), true);
  const patched = descriptor.apply(source);
  const context = vm.createContext({});
  vm.runInContext(patched, context);
  assert.deepEqual(Array.from((await context.build(true, true))["plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled_tools"]), ["automation_update"]);
  assert.equal((await context.build(true, true))["plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled"], true);
  assert.equal((await context.build(true, false))["mcp_servers.codex_app.enabled"], true);
  assert.deepEqual(Object.keys(await context.build(false, true)), ["unrelated"]);
  assert.equal(descriptor.apply(patched), patched);
});

test("automation plugin enablement rejects an unexpected enabled-tools key contract", () => {
  const source = [
    "const pluginKey=`plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.tools`,legacyKey=`mcp_servers.codex_app.tools`;",
    "function key(version){return version?pluginKey:legacyKey}",
    "async function build(local){let result={config:{}},n=[],tools=n.flatMap(e=>e.type===`namespace`?e.tools:[e]),client={getAppServerVersion:()=>!0},inputs={usesDesktopMcp:local};inputs.usesDesktopMcp&&(result.config={...result.config,[key(client.getAppServerVersion())]:tools.map(({name:e})=>e)});return result.config}",
  ].join(";");

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(applyAutomationPluginEnablePatch(source), source);
  } finally {
    console.warn = originalWarn;
  }
});

test("automation plugin enablement rejects flattened tools from another function", () => {
  const source = [
    "const pluginKey=`plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled_tools`,legacyKey=`mcp_servers.codex_app.enabled_tools`;",
    "function key(version){return version?pluginKey:legacyKey}",
    "async function unrelated(){let tools=raw.flatMap(e=>e.type===`namespace`?e.tools:[e]);return tools}",
    "async function build(local){let result={config:{}},tools=[{name:`automation_update`}],client={getAppServerVersion:()=>!0},inputs={usesDesktopMcp:local};inputs.usesDesktopMcp&&(result.config={...result.config,[key(client.getAppServerVersion())]:tools.map(({name:e})=>e)});return result.config}",
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
    "async function nl({useWsl:e,resourcesPath:t=process.resourcesPath}){if(!process.env.CODEX_APP_TOOLS_PIPE_PATH)return unavailable(`missing-pipe`);let{mcpServers:{codex_app:s}}=base,c={...s.env},l=null;return{...s,command:s.command,cwd:`/plugin`,enabled:!1,env:c}}",
    "globalThis.read=nl;globalThis.removePipe=()=>delete process.env.CODEX_APP_TOOLS_PIPE_PATH;",
  ].join("");
  const descriptor = descriptors.find(({ id }) => id === "automation-plugin-pipe");

  assert.ok(descriptor);
  const patched = descriptor.apply(source);
  const context = vm.createContext({});
  vm.runInContext(patched, context);

  const config = await context.read({ useWsl: false });
  assert.equal(config.env.BASE, "preserved");
  assert.equal(config.env.CODEX_APP_TOOLS_PIPE_PATH, "/tmp/codex-app-tools.sock");
  assert.equal((await context.read({ useWsl: true })).env.CODEX_APP_TOOLS_PIPE_PATH, "/tmp/codex-app-tools.sock");
  context.removePipe();
  assert.equal(await context.read({ useWsl: false }), null);
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

test("current habitat automation host retains its migration consent guard", async () => {
  const patched = applyObservableAutomationViewPatch(automationViewFixture());
  const context = vm.createContext({});
  vm.runInContext(patched, context);
  const response = await context.runViaHost("existing", false);
  assert.equal(JSON.parse(response.contentItems[1].text).status, "PAUSED");
  const blocked = await context.runViaHost("existing", true);
  assert.equal(blocked.success, false);
  assert.equal(blocked.contentItems.length, 1);
  assert.equal(blocked.contentItems[0].text,
    "Local automation changes must use the Automations app after migration consent.");
  const changedGuard = automationViewFixture().replace("isLocalMigrationActive", "unknownMigrationState");
  assert.throws(() => applyObservableAutomationViewPatch(changedGuard),
    /did not match the current or patched bundle/);
});

test("automation view patch rejects an unrelated matching store class", () => {
  const mismatchedHost = automationViewFixture(
    "var ActualHost=class{executeUpdateTool(e){return this.#r(e,this)}#r(e,t){return e.hostId===`local`?jz(t,e,e=>null):null}};" +
      "var Decoy=class{async delete({id:e}){return this.#n(e,null)}async#n(e,t){let r=api.kr(e),i=api.Or(e),a=i===`deleted`||i===`not_found`;return{item:r,success:a,status:i}}};" +
      "var Fz=ActualHost;",
  );
  assert.throws(
    () => applyObservableAutomationViewPatch(mismatchedHost),
    /did not match the current or patched bundle/,
  );
});

test("automation view patch rejects a private store routed to a different handler", () => {
  const mismatchedHost = automationViewFixture().replace(
    ":jz(t,e,e=>null):null",
    ":unrelated(t,e,e=>null):null",
  );
  assert.throws(
    () => applyObservableAutomationViewPatch(mismatchedHost),
    /did not match the current or patched bundle/,
  );
});
function genericScheduleOwnerParts({ time = "$vn", number = "LY", parser = "PY", summary = "qvn" } = {}) {
  return {
    helper: `function ${time}(e,t,n){let r=${number}(e),i=${number}(t);return r!=null&&i!=null?syn(r,i):n.dtstart?syn(n.dtstart.getHours(),n.dtstart.getMinutes()):UY}function ${number}(e){return Array.isArray(e)?typeof e[0]==\`number\`?e[0]:null:typeof e==\`number\`?e:null}`,
    parser: `function ${parser}(e){let i=parse(e),o=minute(i),r=original(e),a=days(i);return{freq:i.freq,hasMultipleTimeValues:Array.isArray(i.byhour)&&i.byhour.length>1||Array.isArray(i.byminute)&&i.byminute.length>1,interval:Math.max(1,Math.round(i.interval??1)),minute:o,origOptions:r.origOptions,rruleText:e,time:${time}(i.byhour,i.byminute,i),weekdays:a}}`,
    summary: `function ${summary}(e,t,n=!0){if(!e||e.hasMultipleTimeValues)return null;let n2=days(e.weekdays),r=n2.length===7;if(e.freq!==\`DAILY\`&&e.freq!==\`WEEKLY\`)return null;let a=uvn(e.time,t);return a?Qvn({intl:t,isEveryDay:r,timeLabel:a,weekdays:n2}):null}`,
    consumer: `function renderSchedule(e,t){return ${summary}(${parser}(e),t)}`,
  };
}

function genericScheduleOwner(options = {}, { helperAfterSummary = false } = {}) {
  const parts = genericScheduleOwnerParts(options);
  return helperAfterSummary
    ? parts.consumer + parts.parser + parts.summary + parts.helper
    : parts.helper + parts.parser + parts.summary + parts.consumer;
}

test("current shared schedule contract accepts hoisted helpers and renamed parser fields", () => {
  const source = genericScheduleOwner({}, { helperAfterSummary: true });
  const patched = applyAutomationScheduleMultiTimePatch(source);
  assert.notEqual(patched, source);
  assert.match(patched, /timeValues:codexLinuxRruleTimes\(i\.byhour,i\.byminute,i\)/u);
  assert.match(patched, /function qvn\(e,t,n=!0\)\{if\(!e\)return null/u);
});

test("generalized schedule matcher rejects duplicate, mixed, partial, and incoherent owners", () => {
  const firstParts = genericScheduleOwnerParts();
  const secondParts = genericScheduleOwnerParts({
    time: "Avn",
    number: "BY",
    parser: "CY",
    summary: "Dvn",
  });
  const first = genericScheduleOwner();
  const second = genericScheduleOwner({ time: "Avn", number: "BY", parser: "CY", summary: "Dvn" });
  const patched = applyAutomationScheduleMultiTimePatch(first);
  const cases = [
    first + second,
    patched + second,
    firstParts.parser,
    firstParts.parser + secondParts.helper + secondParts.summary + secondParts.consumer,
    firstParts.helper + firstParts.parser + secondParts.summary + secondParts.consumer,
    firstParts.helper + firstParts.parser + firstParts.summary,
    first + firstParts.consumer,
  ];
  for (const source of cases) {
    assert.equal(applyAutomationScheduleMultiTimePatch(source), source);
  }
});
