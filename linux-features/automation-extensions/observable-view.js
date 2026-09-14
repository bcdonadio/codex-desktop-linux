"use strict";

const IDENT = "[A-Za-z_$][\\w$]*";
const OBSERVABLE_AUTOMATION_VIEW_MARKER = "codexLinuxObservableAutomationView";

const OUTPUT_HELPER = new RegExp(
  "function (" + IDENT + ")\\((" + IDENT + ")\\)\\{return\\{contentItems:" +
    "\\[\\{type:`inputText`,text:(" + IDENT + ")==null\\?`Rendered automation card in the app\\.`:",
  "gu",
);
const DELETE_HANDLER = new RegExp(
  "if\\((" + IDENT + ")\\.mode===`delete`\\)\\{let (" + IDENT +
    ")=\\1\\.id\\?\\?``;try\\{let\\{item:(" + IDENT + "),status:(" + IDENT +
    "),success:(" + IDENT + ")\\}=await (" + IDENT + ")\\.delete\\(\\{id:\\2\\}\\);",
  "gu",
);
const STORE_DELETE_METHOD = new RegExp(
  `async delete\\(\\{id:(${IDENT})\\}\\)\\{let (${IDENT})=(${IDENT})\\.kr\\(\\1\\),(${IDENT})=\\3\\.Or\\(\\1\\),`,
  "gu",
);

function currentAutomationViewContract(source) {
  const outputMatches = [...source.matchAll(new RegExp(OUTPUT_HELPER.source, "gu"))];
  const handlerMatches = [...source.matchAll(new RegExp(DELETE_HANDLER.source, "gu"))];
  const storeMatches = [...source.matchAll(new RegExp(STORE_DELETE_METHOD.source, "gu"))];
  if (outputMatches.length !== 1 || handlerMatches.length !== 1 || storeMatches.length !== 1) {
    return null;
  }

  const output = outputMatches[0];
  if (output[2] !== output[3]) return null;
  const handler = handlerMatches[0];
  const handlerContext = source.slice(handler.index, handler.index + 2200);
  if (!handlerContext.includes(`return{response:${output[1]}()}`)) return null;

  return { output, handler, store: storeMatches[0] };
}

function matchesObservableAutomationViewContract(source) {
  return source.includes(OBSERVABLE_AUTOMATION_VIEW_MARKER) ||
    currentAutomationViewContract(source) != null;
}

function applyObservableAutomationViewPatch(source) {
  if (source.includes(OBSERVABLE_AUTOMATION_VIEW_MARKER)) return source;
  const contract = currentAutomationViewContract(source);
  if (contract == null) {
    if (source.includes("Rendered automation card in the app.")) {
      console.warn(
        "WARN: Could not uniquely identify the automation view handler — skipping observable automation view patch",
      );
    }
    return source;
  }

  const outputFunction = contract.output[1];
  const outputValue = contract.output[2];
  const outputNeedle =
    `${outputValue}==null?\`Rendered automation card in the app.\`:` +
    `${outputValue}.mode===\`create\`?\`Created automation in the app.\`:` +
    `${outputValue}.mode===\`update\`?\`Updated automation in the app.\`:` +
    `${outputValue}.deleteStatus===\`not_found\`?\`Automation already does not exist in the app.\`:` +
    "`Deleted automation in the app.`";
  if (source.indexOf(outputNeedle) === -1 || source.indexOf(outputNeedle) !== source.lastIndexOf(outputNeedle)) {
    console.warn(
      "WARN: Automation result text contract changed — skipping observable automation view patch",
    );
    return source;
  }
  const outputReplacement =
    `${outputValue}==null?\`Rendered automation card in the app.\`:` +
    `${outputValue}.mode===\`view\`?${outputValue}.viewStatus===\`not_found\`?` +
    "`Automation does not exist in the app.`:`Read automation from the app.`:" +
    outputNeedle.slice(outputNeedle.indexOf(`${outputValue}.mode===\`create\``));

  const argumentValue = contract.handler[1];
  const host = contract.handler[6];
  const viewBranch =
    `if(${argumentValue}.mode===\`view\`){let codexLinuxAutomationViewId=${argumentValue}.id??\`\`;try{` +
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

  const storeId = contract.store[1];
  const storeModule = contract.store[3];
  const viewMethod = `async view({id:${storeId}}){return{item:${storeModule}.kr(${storeId})}}`;

  return source
    .replace(outputNeedle, outputReplacement)
    .replace(contract.handler[0], viewBranch + contract.handler[0])
    .replace(contract.store[0], viewMethod + contract.store[0]);
}

module.exports = {
  applyObservableAutomationViewPatch,
  matchesObservableAutomationViewContract,
};
