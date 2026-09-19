"use strict";

const { findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");

const IDENT = "[A-Za-z_$][\\w$]*";
const OBSERVABLE_AUTOMATION_VIEW_MARKER = "codexLinuxObservableAutomationView";

const OUTPUT_HELPER = new RegExp(
  "function (" + IDENT + ")\\((" + IDENT + ")\\)\\{return\\{contentItems:" +
    "\\[\\{type:`inputText`,text:(" + IDENT + ")==null\\?`Rendered automation card in the app\\.`:",
  "gu",
);
const PATCHED_OUTPUT_HELPER = new RegExp(
  "function (" + IDENT + ")\\((" + IDENT + ")\\)\\{return\\{contentItems:" +
    "\\[\\{type:`inputText`,text:(" + IDENT + ")==null\\?`Rendered automation card in the app\\.`:" +
    "\\3\\.mode===`view`\\?\\3\\.viewStatus===`not_found`\\?" +
    "`Automation does not exist in the app\\.`:`Read automation from the app\\.`:",
  "gu",
);
const DELETE_HANDLER = new RegExp(
  "if\\((" + IDENT + ")\\.mode===`delete`\\)\\{let (" + IDENT +
    ")=\\1\\.id\\?\\?``;try\\{let\\{item:(" + IDENT + "),status:(" + IDENT +
    "),success:(" + IDENT + ")\\}=await (" + IDENT + ")\\.delete\\(\\{id:\\2\\}\\);",
  "gu",
);
const STORE_VIEW_METHOD = new RegExp(
  `async view\\(\\{id:(${IDENT})\\}\\)\\{return\\{item:(${IDENT})\\.(${IDENT})\\(\\1\\)\\}\\}`,
  "gu",
);
const PRIVATE_STORE_DELETE_METHOD = new RegExp(
  `async delete\\(\\{id:(${IDENT})\\}\\)\\{return this\\.#(${IDENT})\\(\\1,null\\)\\}` +
    `async#\\2\\((${IDENT}),(${IDENT})\\)\\{[^{}]*?let (${IDENT})=(${IDENT})\\.(${IDENT})\\(\\3\\),` +
    `(${IDENT})=\\6\\.(${IDENT})\\(\\3\\),`,
  "gu",
);
const CLASS_OPEN = new RegExp(
  `var (${IDENT})=class(?: extends ${IDENT}\\.${IDENT})?\\{`,
  "gu",
);

function findMatchingParenthesis(source, openIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (quote != null) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function enclosingHandler(source, index) {
  const prefixes = [...source.slice(0, index + 1).matchAll(
    new RegExp(`async function (${IDENT})\\((${IDENT}),`, "gu"),
  )];
  const prefix = prefixes.at(-1);
  if (prefix == null) return null;
  const parametersOpen = source.indexOf("(", prefix.index);
  const parametersClose = findMatchingParenthesis(source, parametersOpen);
  const open = parametersClose + 1;
  const close = findMatchingBrace(source, open);
  if (parametersOpen === -1 || parametersClose === -1 || source[open] !== "{" || close < index) {
    return null;
  }
  return {
    name: prefix[1],
    host: prefix[2],
    open,
    close,
    source: source.slice(prefix.index, close + 1),
  };
}

function enclosingClass(source, index) {
  const openings = [...source.slice(0, index + 1).matchAll(new RegExp(CLASS_OPEN.source, "gu"))];
  for (const opening of openings.reverse()) {
    const open = source.indexOf("{", opening.index);
    const close = findMatchingBrace(source, open);
    if (open !== -1 && close >= index) {
      return {
        name: opening[1],
        open,
        close,
        source: source.slice(opening.index, close + 1),
      };
    }
  }
  return null;
}

function classDelegatesToHandler(classContract, handlerName) {
  const escapedHandlerName = handlerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const privateDelegation = new RegExp(
    `executeUpdateTool\\((${IDENT})\\)\\{return this\\.#(${IDENT})\\(\\1,this\\)\\}` +
      `[\\s\\S]*?#\\2\\((${IDENT}),(${IDENT})\\)\\{return \\3\\.hostId===\`local\`\\?` +
      `${escapedHandlerName}\\(\\4,\\3,`,
    "u",
  );
  return privateDelegation.test(classContract.source);
}

function linkedStoreContract(source, storeMatches, handlerName) {
  const linked = storeMatches.flatMap((store) => {
    const owner = enclosingClass(source, store.index);
    return owner != null && classDelegatesToHandler(owner, handlerName) ? [{ store, owner }] : [];
  });
  return linked.length === 1 ? linked[0] : null;
}

function occursExactlyOnce(source, value) {
  return source.indexOf(value) !== -1 && source.indexOf(value) === source.lastIndexOf(value);
}

function automationOutputNeedle(outputValue) {
  return `${outputValue}==null?\`Rendered automation card in the app.\`:` +
    `${outputValue}.mode===\`create\`?\`Created automation in the app.\`:` +
    `${outputValue}.mode===\`update\`?\`Updated automation in the app.\`:` +
    `${outputValue}.deleteStatus===\`not_found\`?\`Automation already does not exist in the app.\`:` +
    "`Deleted automation in the app.`";
}

function observableAutomationOutput(outputValue) {
  const original = automationOutputNeedle(outputValue);
  return `${outputValue}==null?\`Rendered automation card in the app.\`:` +
    `${outputValue}.mode===\`view\`?${outputValue}.viewStatus===\`not_found\`?` +
    "`Automation does not exist in the app.`:`Read automation from the app.`:" +
    original.slice(original.indexOf(`${outputValue}.mode===\`create\``));
}

function automationOutputFunction(outputFunction, outputValue, outputText) {
  return `function ${outputFunction}(${outputValue}){return{contentItems:[{type:\`inputText\`,text:${outputText}},` +
    `...${outputValue}==null?[]:[{type:\`inputText\`,text:JSON.stringify(${outputValue})}]],success:!0}}`;
}

function observableViewBranch(argumentValue, host, outputFunction) {
  return `if(${argumentValue}.mode===\`view\`){let codexLinuxAutomationViewId=${argumentValue}.id??\`\`;try{` +
    `let{item:codexLinuxAutomationViewItem}=await ${host}.view({id:codexLinuxAutomationViewId}),` +
    "codexLinuxAutomationViewResult={automationId:codexLinuxAutomationViewId,mode:`view`," +
    "viewStatus:codexLinuxAutomationViewItem==null?`not_found`:`found`," +
    "status:codexLinuxAutomationViewItem?.status??null," +
    "snapshot:codexLinuxAutomationViewItem==null?null:{kind:codexLinuxAutomationViewItem.kind," +
    "name:codexLinuxAutomationViewItem.name,prompt:codexLinuxAutomationViewItem.prompt," +
    "rrule:codexLinuxAutomationViewItem.rrule,status:codexLinuxAutomationViewItem.status}};" +
    `return{response:${outputFunction}(codexLinuxAutomationViewResult)}}catch{return{response:{contentItems:` +
    "[{type:`inputText`,text:`Failed to view automation.`}],success:!1}}}" +
    `}/*${OBSERVABLE_AUTOMATION_VIEW_MARKER}*/`;
}

function observableViewMethod(storeId, storeModule, readMethod = "kr") {
  return `async view({id:${storeId}}){return{item:${storeModule}.${readMethod}(${storeId})}}`;
}

function currentAutomationViewContract(source) {
  const outputMatches = [...source.matchAll(new RegExp(OUTPUT_HELPER.source, "gu"))];
  const handlerMatches = [...source.matchAll(new RegExp(DELETE_HANDLER.source, "gu"))];
  const storeMatches = [...source.matchAll(new RegExp(PRIVATE_STORE_DELETE_METHOD.source, "gu"))];
  if (outputMatches.length !== 1 || handlerMatches.length !== 1 || storeMatches.length === 0) {
    return null;
  }

  const output = outputMatches[0];
  if (output[2] !== output[3]) return null;
  const outputText = automationOutputNeedle(output[2]);
  if (!occursExactlyOnce(source, automationOutputFunction(output[1], output[2], outputText))) {
    return null;
  }
  const handlerMatch = handlerMatches[0];
  const handler = enclosingHandler(source, handlerMatch.index);
  if (handler == null || handler.host !== handlerMatch[6]) return null;
  if (!handler.source.includes(`return{response:${output[1]}()}`)) return null;
  const linkedStore = linkedStoreContract(source, storeMatches, handler.name);
  if (linkedStore == null) return null;

  return { output, handler: handlerMatch, linkedStore };
}

function patchedAutomationViewContract(source) {
  if (source.split(OBSERVABLE_AUTOMATION_VIEW_MARKER).length !== 2) return null;
  const outputMatches = [...source.matchAll(new RegExp(PATCHED_OUTPUT_HELPER.source, "gu"))];
  const storeMatches = [...source.matchAll(new RegExp(STORE_VIEW_METHOD.source, "gu"))];
  if (outputMatches.length !== 1 || storeMatches.length === 0) return null;
  const output = outputMatches[0];
  if (output[2] !== output[3]) return null;

  const markerIndex = source.indexOf(OBSERVABLE_AUTOMATION_VIEW_MARKER);
  const handler = enclosingHandler(source, markerIndex);
  if (handler == null) return null;
  const viewBranch = new RegExp(
    `if\\((${IDENT})\\.mode===\`view\`\\)\\{let codexLinuxAutomationViewId=\\1\\.id\\?\\?\`\`;try\\{` +
      `let\\{item:codexLinuxAutomationViewItem\\}=await (${IDENT})\\.view\\(\\{id:codexLinuxAutomationViewId\\}\\)`,
    "u",
  ).exec(handler.source);
  if (viewBranch == null || viewBranch[2] !== handler.host) return null;
  const expectedOutput = automationOutputFunction(
    output[1],
    output[2],
    observableAutomationOutput(output[2]),
  );
  if (!occursExactlyOnce(source, expectedOutput)) return null;
  const expectedBranch = observableViewBranch(viewBranch[1], viewBranch[2], output[1]);
  if (!occursExactlyOnce(handler.source, expectedBranch)) return null;
  const linkedStore = linkedStoreContract(source, storeMatches, handler.name);
  if (linkedStore == null) return null;
  if (linkedStore.store[0] !== observableViewMethod(
    linkedStore.store[1],
    linkedStore.store[2],
    linkedStore.store[3],
  )) {
    return null;
  }
  return { output, handler, linkedStore };
}

function matchesObservableAutomationViewContract(source) {
  return patchedAutomationViewContract(source) != null || currentAutomationViewContract(source) != null;
}

function applyObservableAutomationViewPatch(source) {
  if (patchedAutomationViewContract(source) != null) return source;
  const contract = currentAutomationViewContract(source);
  if (contract == null) {
    throw new Error("Observable automation view contract did not match the current or patched bundle");
  }

  const outputFunction = contract.output[1];
  const outputValue = contract.output[2];
  const outputNeedle = automationOutputNeedle(outputValue);
  if (!occursExactlyOnce(source, outputNeedle)) {
    throw new Error("Automation result text contract is not unique");
  }
  const outputReplacement = observableAutomationOutput(outputValue);

  const argumentValue = contract.handler[1];
  const host = contract.handler[6];
  const viewBranch = observableViewBranch(argumentValue, host, outputFunction);

  const storeId = contract.linkedStore.store[3];
  const storeModule = contract.linkedStore.store[6];
  const readMethod = contract.linkedStore.store[7];
  const viewMethod = observableViewMethod(storeId, storeModule, readMethod);

  const patched = source
    .replace(outputNeedle, outputReplacement)
    .replace(contract.handler[0], viewBranch + contract.handler[0])
    .replace(contract.linkedStore.store[0], viewMethod + contract.linkedStore.store[0]);
  if (patchedAutomationViewContract(patched) == null) {
    throw new Error("Observable automation view patch did not produce the complete contract");
  }
  return patched;
}

module.exports = {
  applyObservableAutomationViewPatch,
  matchesObservableAutomationViewContract,
};
