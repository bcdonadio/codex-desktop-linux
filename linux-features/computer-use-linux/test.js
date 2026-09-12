"use strict";

const { applyLinuxComputerUsePluginGatePatch } = require("./plugin-gate.js");

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const manifest = require("./feature.json");
const descriptors = require("./patch.js");
const {
  applyLinuxComputerUseHostPlatformPatch,
  applyLinuxCodexAppThreadConfigPatch,
  applyLinuxCodexAppThreadToolsPatch,
  matchesLinuxComputerUseHostPlatformContract,
} = require("../../scripts/patches/impl/computer-use.js");

test("computer-use-linux is opt-in and owns the current Linux descriptors", () => {
  assert.equal(manifest.defaultEnabled, false);
  assert.deepEqual(
    descriptors.map(({ id }) => id),
    [
      "unified-runtime",
      "avatar-cursor",
      "ui-feature",
      "plugin-gate",
      "native-desktop-apps",
      "codex-app-thread-config",
      "codex-app-thread-tools",
      "ui-availability",
      "host-platform",
      "native-settings-visibility",
    ],
  );
});

test("Linux thread resume requests sibling tools only for local Desktop MCP", async () => {
  const source = [
    '"use strict";',
    "function HE(e){return e===`local`}class Nkr{constructor(e){this.params=e}readInputs(){let{hostId:o,dynamicTools:c}=this.params;return{hasDesktopRuntime:!0,usesDesktopMcp:HE(o),readDynamicTools:e=>c.request(e),traceRequest(e){return e}}}}",
    'async function LBt({readDynamicTools,usesDesktopMcp,config}){let n=await readDynamicTools({featureOverrides:{apps:!0}});return usesDesktopMcp?{...config,"mcp_servers.codex_app.enabled_tools":n}:config}',
    "globalThis.seen=null;globalThis.make=async hostId=>{let inputs=new Nkr({hostId,dynamicTools:{request:async e=>{globalThis.seen=e;return e.featureOverrides?.thread_tools===!0?[`create_thread`,`list_threads`,`read_thread`,`wait_threads`,`send_message_to_thread`]:[]}}}).readInputs();return LBt({readDynamicTools:inputs.readDynamicTools,usesDesktopMcp:inputs.usesDesktopMcp,config:{}})};",
  ].join("");

  const before = vm.createContext({});
  vm.runInContext(source, before);
  assert.deepEqual(
    Array.from((await before.make("local"))["mcp_servers.codex_app.enabled_tools"]),
    [],
  );

  const patched = applyLinuxCodexAppThreadToolsPatch(source);
  assert.notEqual(patched, source);
  assert.match(patched, /codexLinuxCodexAppThreadTools/);
  const context = vm.createContext({});
  vm.runInContext(patched, context);
  assert.deepEqual(
    Array.from((await context.make("local"))["mcp_servers.codex_app.enabled_tools"]),
    ["create_thread", "list_threads", "read_thread", "wait_threads", "send_message_to_thread"],
  );
  assert.equal(context.seen.featureOverrides.apps, true);
  assert.equal(context.seen.featureOverrides.thread_tools, true);
  assert.deepEqual(Object.keys(await context.make("remote")), []);
  assert.equal(applyLinuxCodexAppThreadToolsPatch(patched), patched);
});

test("Linux thread resume keeps the complete Codex app MCP transport with tool filters", async () => {
  const source = [
    '"use strict";',
    "var Ope={parse:e=>e},path={join:(...e)=>e.join(`/`)},KT=e=>JSON.stringify(e),browserConfig=async()=>({}),artifactConfig=async()=>({});",
    "async function Ape({hostConfig:e,resourcesPath:t=process.resourcesPath}){let r=process.env.CODEX_APP_TOOLS_PIPE_PATH;if(e.kind!==`local`)return[];let i=!1,a={path:`/plugins/codex-app-tools`},s=JSON.stringify({mcpServers:{codex_app:{command:`launch`,args:[`server.mjs`],env:{}}}}),{mcpServers:{codex_app:c}}=Ope.parse(JSON.parse(s)),l={...c.env,CODEX_APP_TOOLS_PIPE_PATH:r},u=`/node`;if(u!=null&&(l.CODEX_MCP_NODE_PATH=u),i){c.command=`/bin/sh`,c.args=[`-c`,`shim`],c.env_vars=[`WSL_INTEROP`],l.WSLENV=`WSL_INTEROP/w`}return[`mcp_servers.codex_app=${KT({...c,command:process.platform===`win32`?c.command:path.join(a.path,c.command),cwd:i?`/`:a.path,enabled:!0,omit_tools_from:[`deferred`,`code_mode`],env:l})}`]}",
    "class Host{constructor(e){this.kind=e,this.registry={getConnection:()=>({hostConfig:{kind:this.kind}})}}async buildMcpCodexConfig(e){let t=this.registry.getConnection(`local`);let n=!1,r={},[i,a]=await Promise.all([browserConfig(),artifactConfig()]),o={artifactSession:!0};return{...i,...a,...o}}}",
    "globalThis.run=async e=>{let t=await new Host(e).buildMcpCodexConfig(`/workspace`);t[`mcp_servers.codex_app.enabled_tools`]=[`list_threads`];return t};",
  ].join("");

  const patched = applyLinuxCodexAppThreadConfigPatch(source);

  assert.notEqual(patched, source);
  assert.equal(patched.startsWith('"use strict";'), true);
  assert.match(patched, /codexLinuxCodexAppThreadConfig/);
  assert.match(
    patched,
    /\{"mcp_servers\.codex_app":codexLinuxCodexAppThreadConfig\}/,
  );
  const context = vm.createContext({ process: { env: {}, platform: "linux", resourcesPath: "/resources" } });
  vm.runInContext(patched, context);
  const config = await context.run("local");
  assert.deepEqual(
    JSON.parse(JSON.stringify(config["mcp_servers.codex_app"])),
    {
      args: ["server.mjs"],
      command: "/plugins/codex-app-tools/launch",
      cwd: "/plugins/codex-app-tools",
      enabled: true,
      env: {
        CODEX_MCP_NODE_PATH: "/node",
      },
      omit_tools_from: ["deferred", "code_mode"],
    },
  );
  assert.deepEqual(
    [...config["mcp_servers.codex_app.enabled_tools"]],
    ["list_threads"],
  );
  const unavailableConfig = await context.run("remote");
  assert.equal(unavailableConfig["mcp_servers.codex_app"], undefined);

  const reapplied = applyLinuxCodexAppThreadConfigPatch(patched);
  assert.equal(reapplied, patched);
});

test("computer-use-linux staging consumes release artifacts without invoking Cargo", () => {
  const stage = fs.readFileSync(path.join(__dirname, "stage.sh"), "utf8");
  assert.doesNotMatch(stage, /cargo\s+(?:build|install)/);
  assert.match(stage, /target\/release\/codex-computer-use-linux/);
});

test("staging extends the hidden unified plugin and invalidates the browser-only cache", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "computer-use-linux-stage-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const installDir = path.join(workspace, "app");
  const target = path.join(installDir, "resources/plugins/openai-bundled/plugins/unified-computer-use");
  const marketplacePath = path.join(target, "../../.agents/plugins/marketplace.json");
  fs.mkdirSync(path.dirname(marketplacePath), { recursive: true });
  const marketplace = JSON.stringify({ plugins: [{ name: "unified-computer-use" }, { name: "browser" }] });
  fs.writeFileSync(marketplacePath, marketplace);
  fs.mkdirSync(path.join(target, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(target, ".codex-plugin"));
  fs.writeFileSync(path.join(target, ".codex-plugin/plugin.json"), JSON.stringify({ name: "unified-computer-use", version: "26.908.31748", mcpServers: "./.mcp.json" }));
  fs.writeFileSync(path.join(target, ".mcp.json"), JSON.stringify({ mcpServers: { cua_repl: { command: "node", args: [], enabled: false } } }));
  const backend = path.join(workspace, "backend");
  fs.writeFileSync(backend, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const env = { ...process.env, SCRIPT_DIR: path.resolve(__dirname, "../.."), INSTALL_DIR: installDir,
    CODEX_COMPUTER_USE_BINARY_SOURCE: backend, CODEX_COMPUTER_USE_COSMIC_BINARY_SOURCE: backend };
  const stage = () => execFileSync("bash", [path.join(__dirname, "stage.sh")], { env, stdio: "pipe" });
  const mcpPath = path.join(target, ".mcp.json");
  const originalMcp = fs.readFileSync(mcpPath, "utf8");
  const originalManifest = fs.readFileSync(path.join(target, ".codex-plugin/plugin.json"), "utf8");
  for (const invalid of [
    originalMcp.replace('"command":"node"', '"command":"changed"'),
    originalMcp.replace('"args":[]', '"args":["changed"]'),
    originalMcp.replace('"enabled":false', '"enabled":true'),
  ]) {
    fs.writeFileSync(mcpPath, invalid);
    assert.throws(stage, /unified.*contract/i);
    assert.equal(fs.readFileSync(mcpPath, "utf8"), invalid);
    assert.equal(fs.readFileSync(path.join(target, ".codex-plugin/plugin.json"), "utf8"), originalManifest);
    assert.equal(fs.readFileSync(marketplacePath, "utf8"), marketplace);
    assert.equal(fs.existsSync(path.join(target, "scripts/native-client.mjs")), false);
    assert.equal(fs.existsSync(path.join(target, "scripts/native-service.mjs")), false);
  }
  fs.writeFileSync(mcpPath, originalMcp);
  stage();
  const version = JSON.parse(fs.readFileSync(path.join(target, ".codex-plugin/plugin.json"))).version;
  assert.equal(version, "26.908.31748-linux-native.4");
  assert.deepEqual(JSON.parse(fs.readFileSync(marketplacePath)).plugins.map(p => p.name), ["unified-computer-use", "browser", "computer-use"]);
  const settingsManifest = JSON.parse(fs.readFileSync(path.join(target, "../computer-use/.codex-plugin/plugin.json")));
  assert.equal(settingsManifest.mcpServers, undefined);
  assert.equal(fs.existsSync(path.join(target, "../computer-use/.mcp.json")), false);
  assert.equal(fs.existsSync(path.join(target, "../computer-use/bin/codex-computer-use-linux")), false);
  assert.equal(fs.existsSync(path.join(target, "scripts/native-client.mjs")), true);
  assert.equal(fs.existsSync(path.join(target, "scripts/native-service.mjs")), true);
  assert.equal(fs.readFileSync(path.join(target, "bin/codex-computer-use-linux"), "utf8"), fs.readFileSync(backend, "utf8"));
  const legacyMcp = path.join(target, "../computer-use/.mcp.json");
  fs.writeFileSync(legacyMcp, JSON.stringify({ mcpServers: { "computer-use": { command: "./bin/codex-computer-use-linux", args: ["mcp"] } } }));
  stage();
  assert.equal(fs.existsSync(legacyMcp), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, ".codex-plugin/plugin.json"))).version, version);
  const manifestPath = path.join(target, ".codex-plugin/plugin.json");
  const previousManifest = JSON.parse(fs.readFileSync(manifestPath));
  previousManifest.version = "26.901.41600-linux-native.1";
  fs.writeFileSync(manifestPath, JSON.stringify(previousManifest));
  stage();
  assert.equal(JSON.parse(fs.readFileSync(manifestPath)).version, "26.901.41600-linux-native.4");
  stage();
  assert.equal(JSON.parse(fs.readFileSync(manifestPath)).version, "26.901.41600-linux-native.4");
  fs.writeFileSync(mcpPath, "upstream drift");
  assert.throws(stage, /unified.*contract/i);
});

test("current host-platform contract enables Linux without dropping requirement gates", () => {
  const source = "function owner(){let feature={featureName:`computer_use`},p=`linux`,r=h({areRequirementsPending:a,areRequiredFeaturesEnabled:b,enabled:c,isBrowserAndComputerUseAllowed:d,isAnyFeatureLoading:e,isComputerUseGateEnabled:f,isHostCompatiblePlatform:g(p),isPlatformLoading:i,windowType:`electron`});return r}";
  const patched = applyLinuxComputerUseHostPlatformPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /areRequirementsPending:a/);
  assert.match(patched, /isBrowserAndComputerUseAllowed:d/);
  assert.match(patched, /isHostCompatiblePlatform:p===`linux`\|\|g\(p\)/);
  assert.equal(matchesLinuxComputerUseHostPlatformContract(patched), true);
  assert.equal(applyLinuxComputerUseHostPlatformPatch(patched), patched);
});

test("retired host-platform contract is rejected byte-identically", () => {
  const source = "function owner(){let feature={featureName:`computer_use`},p=`linux`,r=h({areRequiredFeaturesEnabled:b,enabled:c,isAnyFeatureLoading:e,isComputerUseGateEnabled:f,isHostCompatiblePlatform:g(p),isPlatformLoading:i,windowType:`electron`});return r}";

  assert.equal(matchesLinuxComputerUseHostPlatformContract(source), false);
  assert.equal(applyLinuxComputerUseHostPlatformPatch(source), source);
});

test("incomplete patched host-platform contract is rejected byte-identically", () => {
  const source = "function owner(){let feature={featureName:`computer_use`},p=`linux`,r=h({areRequiredFeaturesEnabled:b,enabled:c,isBrowserAndComputerUseAllowed:d,isAnyFeatureLoading:e,isComputerUseGateEnabled:f,isHostCompatiblePlatform:p===`linux`||g(p),isPlatformLoading:i,windowType:`electron`});return r}";

  assert.equal(matchesLinuxComputerUseHostPlatformContract(source), false);
  assert.equal(applyLinuxComputerUseHostPlatformPatch(source), source);
});

test("duplicate patched host-platform contracts are rejected byte-identically", () => {
  const contract = "p=`linux`,r=h({areRequirementsPending:a,areRequiredFeaturesEnabled:b,enabled:c,isBrowserAndComputerUseAllowed:d,isAnyFeatureLoading:e,isComputerUseGateEnabled:f,isHostCompatiblePlatform:p===`linux`||g(p),isPlatformLoading:i,windowType:`electron`})";
  const source = `function first(){let feature={featureName:\`computer_use\`},${contract};return r}function second(){let feature={featureName:\`computer_use\`},${contract};return r}`;

  assert.equal(matchesLinuxComputerUseHostPlatformContract(source), false);
  assert.equal(applyLinuxComputerUseHostPlatformPatch(source), source);
});

test("mixed pristine and patched host-platform contracts are rejected byte-identically", () => {
  const pristine = "p=`linux`,r=h({areRequirementsPending:a,areRequiredFeaturesEnabled:b,enabled:c,isBrowserAndComputerUseAllowed:d,isAnyFeatureLoading:e,isComputerUseGateEnabled:f,isHostCompatiblePlatform:g(p),isPlatformLoading:i,windowType:`electron`})";
  const patched = "q=`linux`,s=j({areRequirementsPending:k,areRequiredFeaturesEnabled:l,enabled:m,isBrowserAndComputerUseAllowed:n,isAnyFeatureLoading:o,isComputerUseGateEnabled:t,isHostCompatiblePlatform:q===`linux`||u(q),isPlatformLoading:v,windowType:`electron`})";
  const source = `function owner(){let feature={featureName:\`computer_use\`},${pristine},${patched};return[r,s]}`;

  assert.equal(matchesLinuxComputerUseHostPlatformContract(source), false);
  assert.equal(applyLinuxComputerUseHostPlatformPatch(source), source);
});

test("malformed patched host-platform variable relationship is rejected byte-identically", () => {
  const source = "function owner(){let feature={featureName:`computer_use`},p=`linux`,q=`darwin`,r=h({areRequirementsPending:a,areRequiredFeaturesEnabled:b,enabled:c,isBrowserAndComputerUseAllowed:d,isAnyFeatureLoading:e,isComputerUseGateEnabled:f,isHostCompatiblePlatform:p===`linux`||g(q),isPlatformLoading:i,windowType:`electron`});return r}";

  assert.equal(matchesLinuxComputerUseHostPlatformContract(source), false);
  assert.equal(applyLinuxComputerUseHostPlatformPatch(source), source);
});

// Current signed Linux main-bundle descriptor and selector contracts. Keep the
// Windows entry adjacent: both entries inherit the same native plugin metadata.
const nativeRegistration = "{...n.nc.computerUse,autoInstallOptOutKey:n.sc(n.nc.computerUse.name),isAvailable:({features:e,platform:t})=>t===`darwin`&&e.computerUse,migrate:one}";
const windowsRegistration = "{...n.nc.computerUse,autoInstallOptOutKey:n.sc(n.nc.computerUse.name),isAvailable:({features:e,platform:t})=>t===`win32`&&e.computerUse}";
const nativeSelector = "function Nd(e){if(!(e.platform!==`darwin`||!e.marketplacePluginNames.includes(`computer-use`)))return e.desktopFeatureAvailability.computerUseNodeRepl?`node-repl`:`legacy-mcp`}";
const registrationFixture = `var kd=[${nativeRegistration},${windowsRegistration}];${nativeSelector}`;

function evaluateNativeRegistration(source) {
  const n = {
    nc: { computerUse: { name: "computer-use", installWhenMissing: true, installWhenMissingRequiresOptIn: true } },
    sc: name => `auto-install-opt-out:${name}`,
  };
  const one = () => "migration";
  return new Function("n", "one", `${source};return {descriptors:kd,select:Nd}`)(n, one);
}

test("current spread registration enables Linux while preserving native consent and other platforms", () => {
  const source = applyLinuxComputerUsePluginGatePatch(registrationFixture);
  const { descriptors, select } = evaluateNativeRegistration(source);
  const upstream = evaluateNativeRegistration(registrationFixture).descriptors;
  assert.equal(descriptors.length, 3);
  const native = descriptors.find(d => d.isAvailable({ platform: "linux", features: { computerUse: true } }));
  const mac = descriptors.find(d => d.migrate);
  const windows = descriptors.find(d => d.isAvailable({ platform: "win32", features: { computerUse: true } }));
  for (const platform of ["linux", "darwin", "win32", "freebsd"]) {
    for (const computerUse of [false, true]) {
      const context = { platform, features: { computerUse } };
      assert.equal(native.isAvailable(context), computerUse && platform === "linux");
      assert.equal(windows.isAvailable(context), upstream[1].isAvailable(context));
      assert.equal(mac.isAvailable(context), upstream[0].isAvailable(context));
    }
  }
  assert.equal(native.installWhenMissingRequiresOptIn, true);
  assert.equal(native.installWhenMissing, true);
  assert.equal(native.autoInstallOptOutKey, upstream[0].autoInstallOptOutKey);
  assert.equal(native.migrate, undefined);
  assert.equal(mac.migrate(), "migration");
  assert.ok(source.includes(nativeRegistration));
  assert.ok(source.includes(windowsRegistration));
  for (const platform of ["linux", "darwin", "win32"]) {
    for (const computerUseNodeRepl of [false, true]) {
      const args = { platform, marketplacePluginNames: ["computer-use"], desktopFeatureAvailability: { computerUseNodeRepl } };
      assert.equal(select(args), platform === "linux" ? "legacy-mcp" : platform === "darwin" ? computerUseNodeRepl ? "node-repl" : "legacy-mcp" : undefined);
      assert.equal(select({ ...args, marketplacePluginNames: [] }), undefined);
    }
  }
  assert.equal(applyLinuxComputerUsePluginGatePatch(source), source);
});

test("native registration matching follows renamed aliases and preserves unrelated browser descriptors", () => {
  const browser = "{...n.nc.browser,isAvailable:({features:e})=>e.computerUse||e.externalBrowserUse}";
  const fixture = registrationFixture.replace("var kd=[", `var kd=[${browser},`).replaceAll("n.nc", "q.registry").replaceAll("n.sc", "q.optOut").replaceAll("features:e,platform:t", "features:flags,platform:os").replaceAll("t===", "os===").replaceAll("e.computerUse", "flags.computerUse");
  const result = applyLinuxComputerUsePluginGatePatch(fixture);
  assert.ok(result.includes("os===`linux`&&flags.computerUse"));
  assert.ok(result.includes(browser.replaceAll("n.nc", "q.registry").replaceAll("e.computerUse", "flags.computerUse")));
});

for (const [name, fixture] of [
  ["missing registration with usable selector", nativeSelector],
  ["duplicate native registration", registrationFixture.replace(nativeRegistration, `${nativeRegistration},${nativeRegistration}`)],
  ["mixed patched and original registration", registrationFixture.replace(nativeRegistration, `${nativeRegistration},${nativeRegistration.replace("t===`darwin`", "(t===`darwin`||t===`linux`)")}`)],
  ["wrong opt-out reference", registrationFixture.replace("n.sc(n.nc.computerUse.name)", "n.sc(n.nc.browser.name)")],
  ["partial descriptor", registrationFixture.replace(",migrate:one", "")],
  ["missing Windows descriptor", registrationFixture.replace(`,${windowsRegistration}`, "")],
  ["unsupported gate", registrationFixture.replace("t===`darwin`&&e.computerUse", "t===`darwin`||e.computerUse")],
  ["missing selector", registrationFixture.replace(nativeSelector, "")],
  ["duplicate selectors", registrationFixture + nativeSelector],
]) {
  test(`native plugin patch rejects ${name}`, () => {
    assert.throws(() => applyLinuxComputerUsePluginGatePatch(fixture), /Required Linux Computer Use plugin gate patch failed/);
  });
}


test("native plugin patch rejects partial or duplicate Linux registrations", () => {
  const patched = applyLinuxComputerUsePluginGatePatch(registrationFixture);
  const linux = "{...n.nc.computerUse,autoInstallOptOutKey:n.sc(n.nc.computerUse.name),isAvailable:({features:e,platform:t})=>t===`linux`&&e.computerUse}";
  for (const bad of [
    patched.replace(linux, `${linux},${linux}`),
    patched.replace(linux, linux.replace("&&e.computerUse", "||e.computerUse")),
    patched.replace(linux, linux.replace(".name)", ".name),installWhenMissing:!0")),
    patched.replace(linux, linux.replace("&&e.computerUse}", "&&e.computerUse,migrate:one}")),
  ]) {
    assert.throws(() => applyLinuxComputerUsePluginGatePatch(bad), /Required Linux Computer Use plugin gate patch failed/);
  }
});

// Reject changed complete selectors, including a changed owner beside a valid one.
test("marketplace selector rejects changed expressions and companion owners", () => {
  const patched = applyLinuxComputerUsePluginGatePatch(registrationFixture);
  const patchedSelector = patched.slice(patched.indexOf("function Nd"));
  const registry = registrationFixture.replace(nativeSelector, "");
  for (const selector of [nativeSelector, patchedSelector]) {
    for (const changed of [
      selector.replace("computerUseNodeRepl", "newGate"),
      selector.replace("`legacy-mcp`", "`other-backend`"),
      selector.replace("e.desktopFeatureAvailability", "other.desktopFeatureAvailability"),
      selector.replace("e.platform", "other.platform"),
      selector.replace("return ", "return extra&&"),
      selector.replace("`legacy-mcp`", "`legacy-mcp`&&e.newGate"),
    ]) {
      assert.throws(() => applyLinuxComputerUsePluginGatePatch(registry + changed), /marketplace selector/);
      assert.throws(() => applyLinuxComputerUsePluginGatePatch(registry + selector + changed), /marketplace selector/);
    }
  }
});
