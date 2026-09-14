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

function matchesAutomationPluginEnableContract(source) {
  return source.includes(AUTOMATION_PLUGIN_ENABLE_MARKER) ||
    findAutomationPluginConfigAssignments(source).length === 1;
}

function applyAutomationPluginEnablePatch(source) {
  if (source.includes(AUTOMATION_PLUGIN_ENABLE_MARKER)) return source;

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
  if (!configBody.includes(".flatMap(") || !configBody.includes("type===`namespace`")) {
    console.warn(
      "WARN: Desktop MCP config assignment lacks the dynamic tool flattening contract — skipping automation plugin enable patch",
    );
    return source;
  }

  const keyExpression = match[3];
  const enableEntry =
    `,[${keyExpression}.replace(/\\.enabled_tools$/,\`.enabled\`)]:!0/*${AUTOMATION_PLUGIN_ENABLE_MARKER}*/`;
  return source.slice(0, objectClose) + enableEntry + source.slice(objectClose);
}

module.exports = {
  applyAutomationPluginEnablePatch,
  applyAutomationUpdateEagerToolPatch,
  matchesAutomationPluginEnableContract,
  matchesAutomationUpdateEagerToolContract,
};
