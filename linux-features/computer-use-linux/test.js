"use strict";

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
  applyLinuxCodexAppThreadConfigPatch,
} = require("../../scripts/patches/impl/computer-use.js");

test("computer-use-linux is opt-in and owns the current Linux descriptors", () => {
  assert.equal(manifest.defaultEnabled, false);
  assert.deepEqual(
    descriptors.map(({ id }) => id),
    [
      "avatar-cursor",
      "ui-feature",
      "plugin-gate",
      "native-desktop-apps",
      "codex-app-thread-config",
      "ui-availability",
      "host-platform",
    ],
  );
});

test("Linux thread resume keeps the complete Codex app MCP transport with tool filters", async () => {
  const source = [
    '"use strict";',
    "var Ope={parse:e=>e},path={join:(...e)=>e.join(`/`)},KT=e=>JSON.stringify(e),browserConfig=async()=>({}),artifactConfig=async()=>({});",
    "async function Ape({hostConfig:e,resourcesPath:t=process.resourcesPath}){let r=process.env.CODEX_APP_TOOLS_PIPE_PATH;if(e.kind!==`local`)return[];let i=!1,a={path:`/plugins/codex-app-tools`},s=JSON.stringify({mcpServers:{codex_app:{command:`launch`,args:[`server.mjs`],env:{}}}}),{mcpServers:{codex_app:c}}=Ope.parse(JSON.parse(s)),l={...c.env,CODEX_APP_TOOLS_PIPE_PATH:r},u=`/node`;if(u!=null&&(l.CODEX_MCP_NODE_PATH=u),i){c.command=`/bin/sh`,c.args=[`-c`,`shim`],c.env_vars=[`WSL_INTEROP`],l.WSLENV=`WSL_INTEROP/w`}return[`mcp_servers.codex_app=${KT({...c,command:process.platform===`win32`?c.command:path.join(a.path,c.command),cwd:i?`/`:a.path,enabled:!0,omit_tools_from:[`deferred`,`code_mode`],env:l})}`]}",
    "class Host{constructor(e){this.kind=e,this.registry={getConnection:()=>({hostConfig:{kind:this.kind}})}}async buildMcpCodexConfig(e){let t=this.registry.getConnection(`local`);let n=!1,r={},[i,a]=await Promise.all([browserConfig(),artifactConfig()]);return{...i,...a}}}",
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

test("computer-use-linux staging registers the bundled plugin idempotently", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "computer-use-linux-stage-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

  const installDir = path.join(workspace, "app");
  const releaseDir = path.join(workspace, "target", "release");
  const marketplacePath = path.join(
    installDir,
    "resources/plugins/openai-bundled/.agents/plugins/marketplace.json",
  );
  fs.mkdirSync(path.dirname(marketplacePath), { recursive: true });
  fs.writeFileSync(
    marketplacePath,
    `${JSON.stringify({ plugins: [{ name: "browser", source: { source: "local", path: "./plugins/browser" } }] })}\n`,
  );
  fs.mkdirSync(releaseDir, { recursive: true });
  for (const binary of ["codex-computer-use-linux", "codex-computer-use-cosmic"]) {
    const binaryPath = path.join(releaseDir, binary);
    fs.writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }

  const env = {
    ...process.env,
    SCRIPT_DIR: workspace,
    INSTALL_DIR: installDir,
    CODEX_COMPUTER_USE_BINARY_SOURCE: path.join(releaseDir, "codex-computer-use-linux"),
    CODEX_COMPUTER_USE_COSMIC_BINARY_SOURCE: path.join(releaseDir, "codex-computer-use-cosmic"),
  };
  fs.mkdirSync(path.join(workspace, "plugins/openai-bundled/plugins"), { recursive: true });
  fs.cpSync(
    path.resolve(__dirname, "../../plugins/openai-bundled/plugins/computer-use"),
    path.join(workspace, "plugins/openai-bundled/plugins/computer-use"),
    { recursive: true },
  );

  execFileSync("bash", [path.join(__dirname, "stage.sh")], { env });
  execFileSync("bash", [path.join(__dirname, "stage.sh")], { env });

  const marketplace = JSON.parse(fs.readFileSync(marketplacePath, "utf8"));
  assert.equal(marketplace.plugins.filter(({ name }) => name === "computer-use").length, 1);
  assert.ok(marketplace.plugins.some(({ name }) => name === "browser"));
  assert.deepEqual(
    marketplace.plugins.find(({ name }) => name === "computer-use"),
    {
      name: "computer-use",
      source: { source: "local", path: "./plugins/computer-use" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    },
  );
  assert.equal(
    fs.existsSync(
      path.join(
        installDir,
        "resources/plugins/openai-bundled/plugins/computer-use/bin/codex-computer-use-linux",
      ),
    ),
    true,
  );
});
