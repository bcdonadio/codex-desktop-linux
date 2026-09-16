"use strict";

const { findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");

const IDENT = "[A-Za-z_$][\\w$]*";
const MARKER = "codexLinuxForwardAutomationPipe";
const PIPE_NAME = "CODEX_APP_TOOLS_PIPE_PATH";
const CONFIG_FUNCTION = new RegExp(
  "async function " + IDENT + "\\(\\{hostConfig:" + IDENT + ",resourcesPath:" + IDENT +
    "=process\\.resourcesPath\\}\\)\\{if\\(!process\\.env\\." + PIPE_NAME +
    "\\)return " + IDENT + "\\(`missing-pipe`\\);",
  "gu",
);

function findPipeForwardTargets(source) {
  const targets = [];
  for (const functionMatch of source.matchAll(new RegExp(CONFIG_FUNCTION.source, "gu"))) {
    const signatureEnd = functionMatch[0].indexOf("}){");
    if (signatureEnd === -1) continue;
    const functionOpen = functionMatch.index + signatureEnd + 2;
    const functionClose = findMatchingBrace(source, functionOpen);
    if (functionClose === -1) continue;
    const body = source.slice(functionOpen, functionClose + 1);
    const servers = [...body.matchAll(new RegExp(`codex_app:(${IDENT})\\}\\}=`, "gu"))];
    if (servers.length !== 1) continue;
    const server = servers[0][1];
    const envMatches = [
      ...body.matchAll(new RegExp(`,(${IDENT})=\\{\\.\\.\\.${server}\\.env\\},`, "gu")),
    ];
    if (envMatches.length !== 1) continue;
    const env = envMatches[0][1];
    if (!body.includes(`env:${env}`)) continue;
    targets.push({
      env,
      replaceEnd: functionOpen + envMatches[0].index + envMatches[0][0].length,
      replaceStart: functionOpen + envMatches[0].index,
      server,
    });
  }
  return targets;
}

function findPatchedPipeContracts(source) {
  const contracts = [];
  for (const functionMatch of source.matchAll(new RegExp(CONFIG_FUNCTION.source, "gu"))) {
    const signatureEnd = functionMatch[0].indexOf("}){");
    if (signatureEnd === -1) continue;
    const functionOpen = functionMatch.index + signatureEnd + 2;
    const functionClose = findMatchingBrace(source, functionOpen);
    if (functionClose === -1) continue;
    const body = source.slice(functionOpen, functionClose + 1);
    const servers = [...body.matchAll(new RegExp(`codex_app:(${IDENT})\\}\\}=`, "gu"))];
    if (servers.length !== 1) continue;
    const server = servers[0][1];
    const envMatches = [
      ...body.matchAll(
        new RegExp(
          `,(${IDENT})=\\{\\.\\.\\.${server}\\.env,${PIPE_NAME}:process\\.env\\.${PIPE_NAME}/\\*${MARKER}\\*/\\},`,
          "gu",
        ),
      ),
    ];
    if (envMatches.length !== 1) continue;
    const env = envMatches[0][1];
    if (body.includes(`env:${env}`)) contracts.push({ env, server });
  }
  return contracts;
}

function applyAutomationPluginPipePatch(source) {
  if (source.includes(MARKER)) {
    const markerCount = source.split(MARKER).length - 1;
    if (markerCount === 1 && findPatchedPipeContracts(source).length === 1) return source;
    throw new Error("Automation plugin pipe patch did not match the current bundle exactly once");
  }

  const targets = findPipeForwardTargets(source);
  if (targets.length !== 1) {
    throw new Error("Automation plugin pipe patch did not match the current bundle exactly once");
  }

  const { env, replaceEnd, replaceStart, server } = targets[0];
  const replacement =
    `,${env}={...${server}.env,${PIPE_NAME}:process.env.${PIPE_NAME}/*${MARKER}*/},`;
  return source.slice(0, replaceStart) + replacement + source.slice(replaceEnd);
}

module.exports = { applyAutomationPluginPipePatch };
