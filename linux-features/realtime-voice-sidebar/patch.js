"use strict";

const { findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");

const PATCH_MARKER = "codexLinuxRealtimeVoiceSidebarGate";
const VOICE_START_LABEL = "sidebar.voice.startAriaLabel";
const VOICE_LABEL = "sidebar.voice.label";
const FUNCTION_PATTERN = /function\s+[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/g;
const GATE_PATTERN = /Qze\(([A-Za-z_$][\w$]*),`2919110489`\)\.get\(`enabled`,!1\)/g;
const FORCED_GATE_PATTERN = /!0\/\*codexLinuxRealtimeVoiceSidebarGate\*\//g;

function warn(message) {
  console.warn(`WARN: ${message} - skipping realtime voice sidebar patch`);
}

function functionRanges(source) {
  const ranges = [];
  for (const match of source.matchAll(FUNCTION_PATTERN)) {
    const open = match.index + match[0].lastIndexOf("{");
    const close = findMatchingBrace(source, open);
    if (close !== -1) ranges.push({ start: match.index, end: close + 1 });
  }
  return ranges;
}

function countExact(body, value) {
  return body.split(value).length - 1;
}

function footerContracts(source) {
  const ranges = functionRanges(source);
  const contractsByGate = new Map();
  for (const enclosing of ranges) {
    const body = source.slice(enclosing.start, enclosing.end);
    if (countExact(body, VOICE_START_LABEL) !== 1 || countExact(body, VOICE_LABEL) !== 1) continue;

    const gates = [...body.matchAll(GATE_PATTERN)];
    const forced = [...body.matchAll(FORCED_GATE_PATTERN)];
    if (gates.length === 1 && forced.length === 0) {
      const gateStart = enclosing.start + gates[0].index;
      contractsByGate.set(gateStart, {
        gateStart,
        gateLength: gates[0][0].length,
        patched: false,
      });
    } else if (gates.length === 0 && forced.length === 1) {
      const gateStart = enclosing.start + forced[0].index;
      contractsByGate.set(gateStart, { gateStart, gateLength: forced[0][0].length, patched: true });
    }
  }
  return [...contractsByGate.values()];
}

function applyRealtimeVoiceSidebarPatch(source) {
  const contracts = footerContracts(source);
  if (contracts.length === 1 && contracts[0].patched) return source;
  if (contracts.length !== 1 || contracts[0].patched) {
    warn(
      contracts.length === 0
        ? "Could not find exactly one complete sidebar Voice footer contract"
        : "Found multiple or mixed sidebar Voice footer contracts",
    );
    return source;
  }

  const { gateStart, gateLength } = contracts[0];
  const gate = source.slice(gateStart, gateStart + gateLength);
  const patchedGate = `!0/*${PATCH_MARKER}*/`;
  return source.slice(0, gateStart) + patchedGate + source.slice(gateStart + gateLength);
}

const descriptors = [
  {
    id: "sidebar-entrypoint",
    phase: "webview-asset",
    order: 20560,
    ciPolicy: "optional",
    pattern: /^app-primary-[^.]+\.js$/,
    missingDescription: "sidebar primary webview bundle",
    skipDescription: "realtime voice sidebar entrypoint patch",
    apply: applyRealtimeVoiceSidebarPatch,
  },
];

module.exports = {
  applyRealtimeVoiceSidebarPatch,
  descriptors,
};
