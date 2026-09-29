"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const manifest = require("./feature.json");
const descriptors = require("./patch.js");
const {
  applyLinuxAppShellTabLayoutPerformancePatch,
  applyLinuxMarkdownAnimationPerformancePatch,
  matchesLinuxAppShellTabLayoutPerformanceContract,
  matchesLinuxMarkdownAnimationPerformanceContract,
} = require("./implementation.js");

function currentAppShellTabLayoutFixture() {
  return [
    "function B2t(){let ue=(e,t)=>{ae(t.scrollWidth>t.clientWidth)},de=Jc(ue);return jsx(`button`,{\"data-app-shell-tab-close-button\":!0,className:`@max-[4rem]/app-shell-tab:invisible`})}",
    "function sAn(e){let{targetWidth:b,sharesTabWidth:m,animateLayout:n}=e,O=b===void 0?null:b,P=O==null?m?fAn:dAn:pAn,ce=n?P:!1,q=0;return jsx(Motion.div,{animate:ae,\"data-app-shell-tab-controller\":h,exit:oe,inert:se,initial:ce,style:he,transition:be,onAnimationComplete:xe,className:`@container/app-shell-tab`})}",
  ].join("");
}

test("linux-performance-workarounds remains an opt-in renderer-only feature", () => {
  assert.equal(manifest.defaultEnabled, false);
  assert.deepEqual(
    descriptors.map(({ id, phase }) => [id, phase]),
    [
      ["sidebar-scroll", "webview-asset"],
      ["app-shell-tab-layout", "webview-asset"],
      ["markdown-animation", "webview-asset"],
    ],
  );
  assert.equal(descriptors[0].pattern.test("app-primary-a0bff570446b.js"), false);
  assert.equal(descriptors[0].pattern.test("app-initial-cccb87527a41.js"), true);
  assert.equal(descriptors[1].pattern.test("app-initial-cccb87527a41.js"), true);
  assert.equal(descriptors[2].pattern.test("app-initial-a3898107ddbb.css"), true);
  assert.equal(descriptors[2].pattern.test("app-primary-547a6c7b4fb3.css"), false);
});

test("app-shell tab workaround fails closed for missing, duplicate, mixed, and partial owners", () => {
  const owner = currentAppShellTabLayoutFixture();
  const patched = applyLinuxAppShellTabLayoutPerformancePatch(owner);
  const renamed = owner
    .replaceAll("B2t", "B3t")
    .replaceAll("sAn", "sBn")
    .replaceAll("fAn", "fBn")
    .replaceAll("dAn", "dBn")
    .replaceAll("pAn", "pBn");
  const cases = [
    owner.replace("initial:ce", "initial:!1"),
    owner + renamed,
    patched + renamed,
    owner.replace("data-app-shell-tab-close-button", "data-close-button"),
  ];
  for (const source of cases) {
    assert.equal(matchesLinuxAppShellTabLayoutPerformanceContract(source), false);
    assert.equal(applyLinuxAppShellTabLayoutPerformancePatch(source), source);
  }
});

test("signed stable app-shell tab workaround keeps deferred overflow and disables initial layout animation", () => {
  const source = currentAppShellTabLayoutFixture();
  assert.equal(matchesLinuxAppShellTabLayoutPerformanceContract(source), true);
  const patched = applyLinuxAppShellTabLayoutPerformancePatch(source);
  assert.notEqual(patched, source);
  assert.match(patched, /ue=\(e,t\)=>\{codexLinuxScheduleAppShellTabOverflow\(t,ae\)\}/u);
  assert.match(patched, /ce=!1/u);
  assert.doesNotThrow(() => new Function(patched));
  assert.equal(matchesLinuxAppShellTabLayoutPerformanceContract(patched), true);
  assert.equal(applyLinuxAppShellTabLayoutPerformancePatch(patched), patched);
});

test("signed stable Markdown rules disable fades while preserving streaming declarations", () => {
  const source = "._MarkdownRoot_lyk9f_2[data-markdown-animated] :is(._FadeIn_lyk9f_2,._HorizontalRule_lyk9f_2,._ListItem_lyk9f_2,._TableRow_lyk9f_2,._Blockquote_lyk9f_2){opacity:1;animation:_fade-in_lyk9f_2 var(--duration,var(--transition-duration-basic)) var(--fade-easing,cubic-bezier(.37, .55, .86, .88)) both;animation-delay:var(--fade-delay,0s)}._MarkdownRoot_lyk9f_2[data-markdown-animated] ._FadeListDecoration_lyk9f_2::marker{animation:_fade-in-marker_lyk9f_2 var(--duration,var(--transition-duration-basic)) var(--fade-easing,cubic-bezier(.37, .55, .86, .88)) forwards;animation-delay:var(--fade-delay,0s)}._MarkdownRoot_lyk9f_2._AdaptiveStreaming_lyk9f_2 ._FadeIn_lyk9f_2{--duration:var(--animation-duration-streaming-text)}._MarkdownRoot_lyk9f_2._AdaptiveStreaming_lyk9f_2 ._FadeListDecoration_lyk9f_2::marker{--duration:var(--animation-duration-streaming-text)}._MarkdownRoot_lyk9f_2[data-markdown-animated] ._ImageEnter_lyk9f_2{transform-origin:50%;animation:.18s ease-out both _image-enter_lyk9f_2}";
  assert.equal(matchesLinuxMarkdownAnimationPerformanceContract(source), true);
  const patched = applyLinuxMarkdownAnimationPerformancePatch(source);
  assert.notEqual(patched, source);
  assert.match(patched, /FadeIn_lyk9f_2[^{}]*\{opacity:1;animation:none\}/u);
  assert.match(patched, /FadeListDecoration_lyk9f_2::marker\{animation:none\}/u);
  assert.match(patched, /_AdaptiveStreaming_lyk9f_2 ._FadeIn_lyk9f_2/u);
  assert.equal(matchesLinuxMarkdownAnimationPerformanceContract(patched), true);
  assert.equal(applyLinuxMarkdownAnimationPerformancePatch(patched), patched);
});
