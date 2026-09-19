"use strict";

const { findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");

const IDENT = "[A-Za-z_$][\\w$]*";
const EAGER = new RegExp(`${IDENT}\\.name!==\\\`automation_update\\\`&&${IDENT}&&\\(!${IDENT}\\.has\\(${IDENT}\\.name\\)\\|\\|${IDENT}\\.includes\\(${IDENT}\\.name\\)\\)`);
const DYNAMIC = new RegExp(
  `\\.map\\((${IDENT})=>\\(\\{type:\`function\`,\\.\\.\\.\\1,\\.\\.\\.(` +
    `${IDENT}&&\\(!${IDENT}\\.has\\(\\1\\.name\\)\\|\\|${IDENT}\\.includes\\(\\1\\.name\\)\\)` +
    `)\\?\\{deferLoading:!0\\}:\\{\\}\\}\\)\\)`,
  "u",
);
const AUTOMATION_PLUGIN_ENABLE_MARKER = "codexLinuxEnableAutomationPluginTransport";
const AUTOMATION_PLUGIN_ENABLED_TOOL_KEYS = [
  "plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled_tools",
  "mcp_servers.codex_app.enabled_tools",
];
const DESKTOP_MCP_CONFIG_PREFIX = new RegExp(
  `(${IDENT})\\.usesDesktopMcp&&\\((${IDENT})\\.config=\\{\\.\\.\\.\\2\\.config,\\[(${IDENT}\\((${IDENT})\\.getAppServerVersion\\(\\)\\))\\]:`,
  "gu",
);

function matchesAutomationUpdateEagerToolContract(source) {
  return EAGER.test(source) || DYNAMIC.test(source);
}

function applyAutomationUpdateEagerToolPatch(source) {
  if (EAGER.test(source)) return source;
  if (!DYNAMIC.test(source)) {
    if (source.includes("automation_update") && source.includes("deferLoading:!0")) {
      console.warn("WARN: Could not find dynamic tools construction point — skipping automation_update eager tool patch");
    }
    return source;
  }
  return source.replace(
    DYNAMIC,
    (_match, tool, deferCondition) =>
      `.map(${tool}=>({type:\`function\`,...${tool},...${tool}.name!==\`automation_update\`&&${deferCondition}?{deferLoading:!0}:{}}))`,
  );
}

function findAutomationPluginConfigAssignments(source) {
  return [...source.matchAll(new RegExp(DESKTOP_MCP_CONFIG_PREFIX.source, "gu"))];
}

function enclosingAsyncFunction(source, index) {
  const candidates = [
    ...source.slice(0, index + 1).matchAll(new RegExp(`async function ${IDENT}\\(`, "gu")),
  ];
  for (const candidate of candidates.reverse()) {
    const parametersOpen = source.indexOf("(", candidate.index);
    let depth = 0;
    let parametersClose = -1;
    for (let cursor = parametersOpen; cursor < source.length; cursor += 1) {
      if (source[cursor] === "(") depth += 1;
      if (source[cursor] === ")" && --depth === 0) {
        parametersClose = cursor;
        break;
      }
    }
    const open = parametersClose + 1;
    const close = findMatchingBrace(source, open);
    if (parametersOpen !== -1 && parametersClose !== -1 && source[open] === "{" && close >= index) {
      return { open, close };
    }
  }
  return null;
}

function hasDynamicToolFlatteningContract(source, match, configBody) {
  const valueMatch = new RegExp(
    `:\\s*(${IDENT})\\.map\\(\\(\\{name:(${IDENT})\\}\\)=>\\2\\)`,
    "u",
  ).exec(configBody);
  if (valueMatch == null) return false;
  const owner = enclosingAsyncFunction(source, match.index);
  if (owner == null) return false;
  const prefix = source.slice(owner.open + 1, match.index);
  const escaped = valueMatch[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:let |const |var |,)${escaped}=${IDENT}\\.flatMap\\((${IDENT})=>` +
      `\\1\\.type===\`namespace\`\\?\\1\\.tools:\\[\\1\\]\\)`,
    "u",
  ).test(prefix);
}

function hasAutomationPluginEnabledToolsKeyContract(source) {
  return AUTOMATION_PLUGIN_ENABLED_TOOL_KEYS.every((key) => source.includes(key));
}

function matchesAutomationPluginEnableContract(source) {
  return source.includes(AUTOMATION_PLUGIN_ENABLE_MARKER) ||
    hasAutomationPluginEnabledToolsKeyContract(source) &&
      findAutomationPluginConfigAssignments(source).length === 1;
}

function applyAutomationPluginEnablePatch(source) {
  if (source.includes(AUTOMATION_PLUGIN_ENABLE_MARKER)) return source;

  if (!hasAutomationPluginEnabledToolsKeyContract(source)) {
    if (source.includes("codex_app.enabled_tools") || source.includes("codex_app.tools")) {
      console.warn(
        "WARN: Codex app enabled-tools config keys changed — skipping automation plugin enable patch",
      );
    }
    return source;
  }

  const matches = findAutomationPluginConfigAssignments(source);
  if (matches.length !== 1) {
    if (source.includes("mcp_servers.codex_app.enabled_tools")) {
      console.warn(
        "WARN: Could not uniquely identify Desktop MCP enabled-tools config — skipping automation plugin enable patch",
      );
    }
    return source;
  }

  const match = matches[0];
  const objectOpen = source.indexOf("{", match.index + match[0].indexOf(".config="));
  const objectClose = findMatchingBrace(source, objectOpen);
  if (objectOpen === -1 || objectClose === -1 || source[objectClose + 1] !== ")") {
    console.warn(
      "WARN: Could not identify complete Desktop MCP config assignment — skipping automation plugin enable patch",
    );
    return source;
  }

  const configBody = source.slice(objectOpen, objectClose + 1);
  if (!hasDynamicToolFlatteningContract(source, match, configBody)) {
    console.warn(
      "WARN: Desktop MCP config assignment lacks the dynamic tool flattening contract — skipping automation plugin enable patch",
    );
    return source;
  }

  const keyExpression = match[3];
  const enableEntry =
    `,...(e=>{if(typeof e!==\`string\`||!e.endsWith(\`.enabled_tools\`))throw Error(\`Unexpected Codex app enabled-tools config key\`);return{[e.slice(0,-\`.enabled_tools\`.length)+\`.enabled\`]:!0}})(${keyExpression})/*${AUTOMATION_PLUGIN_ENABLE_MARKER}*/`;
  return source.slice(0, objectClose) + enableEntry + source.slice(objectClose);
}

module.exports = {
  applyAutomationPluginEnablePatch,
  applyAutomationUpdateEagerToolPatch,
  matchesAutomationPluginEnableContract,
  matchesAutomationUpdateEagerToolContract,
};
