/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*- */
/* vim: set ft=javascript ts=2 et sw=2 tw=80: */
/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

/* import-globals-from shared-head.js */
"use strict";

// Tests that changing preferences in the options panel updates the prefs
// and toggles appropriate things in the toolbox.

var doc = null, toolbox = null, panelWin = null, modifiedPrefs = [];
const {LocalizationHelper} = require("devtools/shared/l10n");
const L10N = new LocalizationHelper("devtools/client/locales/toolbox.properties");
const {PrefObserver} = require("devtools/client/shared/prefs");

add_task(async function () {
  const URL = "data:text/html;charset=utf8,test for dynamically registering " +
              "and unregistering tools";
  registerNewTool();
  let tab = await addTab(URL);
  let target = TargetFactory.forTab(tab);
  toolbox = await gDevTools.showToolbox(target);
  doc = toolbox.doc;
  await registerNewPerToolboxTool();
  await testSelectTool();
  await testOptionsShortcut();
  await testOptions();
  await testToggleTools();
  await cleanup();
});

function registerNewTool() {
  let toolDefinition = {
    id: "test-tool",
    isTargetSupported: () => true,
    visibilityswitch: "devtools.test-tool.enabled",
    url: "about:blank",
    label: "someLabel"
  };

  ok(gDevTools, "gDevTools exists");
  ok(!gDevTools.getToolDefinitionMap().has("test-tool"),
    "The tool is not registered");

  gDevTools.registerTool(toolDefinition);
  ok(gDevTools.getToolDefinitionMap().has("test-tool"),
    "The tool is registered");
}

function registerNewPerToolboxTool() {
  let toolDefinition = {
    id: "test-pertoolbox-tool",
    isTargetSupported: () => true,
    visibilityswitch: "devtools.test-pertoolbox-tool.enabled",
    url: "about:blank",
    label: "perToolboxSomeLabel"
  };

  ok(gDevTools, "gDevTools exists");
  ok(!gDevTools.getToolDefinitionMap().has("test-pertoolbox-tool"),
     "The per-toolbox tool is not registered globally");

  ok(toolbox, "toolbox exists");
  ok(!toolbox.hasAdditionalTool("test-pertoolbox-tool"),
     "The per-toolbox tool is not yet registered to the toolbox");

  toolbox.addAdditionalTool(toolDefinition);

  ok(!gDevTools.getToolDefinitionMap().has("test-pertoolbox-tool"),
     "The per-toolbox tool is not registered globally");
  ok(toolbox.hasAdditionalTool("test-pertoolbox-tool"),
     "The per-toolbox tool has been registered to the toolbox");
}

async function testSelectTool() {
  info("Checking to make sure that the options panel can be selected.");

  let onceSelected = toolbox.once("options-selected");
  toolbox.selectTool("options");
  await onceSelected;
  ok(true, "Toolbox selected via selectTool method");
}

async function testOptionsShortcut() {
  info("Selecting another tool, then reselecting options panel with keyboard.");

  await toolbox.selectTool("webconsole");
  is(toolbox.currentToolId, "webconsole", "webconsole is selected");
  synthesizeKeyShortcut(L10N.getStr("toolbox.options.key"));
  is(toolbox.currentToolId, "options", "Toolbox selected via shortcut key (1)");
  synthesizeKeyShortcut(L10N.getStr("toolbox.options.key"));
  is(toolbox.currentToolId, "webconsole", "webconsole is selected (1)");

  await toolbox.selectTool("webconsole");
  is(toolbox.currentToolId, "webconsole", "webconsole is selected");
  synthesizeKeyShortcut(L10N.getStr("toolbox.help.key"));
  is(toolbox.currentToolId, "options", "Toolbox selected via shortcut key (2)");
  synthesizeKeyShortcut(L10N.getStr("toolbox.options.key"));
  is(toolbox.currentToolId, "webconsole", "webconsole is reselected (2)");
  synthesizeKeyShortcut(L10N.getStr("toolbox.help.key"));
  is(toolbox.currentToolId, "options", "Toolbox selected via shortcut key (2)");
}

async function testOptions() {
  let tool = toolbox.getPanel("options");
  panelWin = tool.panelWin;
  let prefNodes = tool.panelDoc.querySelectorAll(
    "input[type=checkbox][data-pref]");

  // Store modified pref names so that they can be cleared on error.
  for (let node of tool.panelDoc.querySelectorAll("[data-pref]")) {
    let pref = node.getAttribute("data-pref");
    modifiedPrefs.push(pref);
  }

  for (let node of prefNodes) {
    let prefValue = GetPref(node.getAttribute("data-pref"));

    // Test clicking the checkbox for each options pref
    await testMouseClick(node, prefValue);

    // Do again with opposite values to reset prefs
    await testMouseClick(node, !prefValue);
  }

  let prefSelects = tool.panelDoc.querySelectorAll("select[data-pref]");
  for (let node of prefSelects) {
    await testSelect(node);
  }
}

async function testSelect(select) {
  let pref = select.getAttribute("data-pref");
  let options = Array.from(select.options);
  info("Checking select for: " + pref);

  is(select.options[select.selectedIndex].value, GetPref(pref),
    "select starts out selected");

  for (let option of options) {
    if (options.indexOf(option) === select.selectedIndex) {
      continue;
    }

    let observer = new PrefObserver("devtools.");

    let deferred = defer();
    let changeSeen = false;
    observer.once(pref, () => {
      changeSeen = true;
      is(GetPref(pref), option.value, "Preference been switched for " + pref);
      deferred.resolve();
    });

    select.selectedIndex = options.indexOf(option);
    let changeEvent = new Event("change");
    select.dispatchEvent(changeEvent);

    await deferred.promise;

    ok(changeSeen, "Correct pref was changed");
    observer.destroy();
  }
}

async function testMouseClick(node, prefValue) {
  let deferred = defer();

  let observer = new PrefObserver("devtools.");

  let pref = node.getAttribute("data-pref");
  let changeSeen = false;
  observer.once(pref, () => {
    changeSeen = true;
    is(GetPref(pref), !prefValue, "New value is correct for " + pref);
    deferred.resolve();
  });

  node.scrollIntoView();

  // We use executeSoon here to ensure that the element is in view and
  // clickable.
  executeSoon(function () {
    info("Click event synthesized for pref " + pref);
    EventUtils.synthesizeMouseAtCenter(node, {}, panelWin);
  });

  await deferred.promise;

  ok(changeSeen, "Correct pref was changed");
  observer.destroy();
}

async function testToggleTools() {
  let toolNodes = panelWin.document.querySelectorAll(
    "#default-tools-box input[type=checkbox]:not([data-unsupported])," +
    "#additional-tools-box input[type=checkbox]:not([data-unsupported])");
  let enabledTools = [...toolNodes].filter(node => node.checked);

  let toggleableTools = gDevTools.getDefaultTools()
                                 .filter(tool => {
                                   return tool.visibilityswitch;
                                 })
                                 .concat(gDevTools.getAdditionalTools())
                                 .concat(toolbox.getAdditionalTools());


  for (let node of toolNodes) {
    let id = node.getAttribute("id");
    ok(toggleableTools.some(tool => tool.id === id),
      "There should be a toggle checkbox for: " + id);
  }

  // Store modified pref names so that they can be cleared on error.
  for (let tool of toggleableTools) {
    let pref = tool.visibilityswitch;
    modifiedPrefs.push(pref);
  }

  // Toggle each tool
  for (let node of toolNodes) {
    await toggleTool(node);
  }
  // Toggle again to reset tool enablement state
  for (let node of toolNodes) {
    await toggleTool(node);
  }

  // Test that a tool can still be added when no tabs are present:
  // Disable all tools
  for (let node of enabledTools) {
    await toggleTool(node);
  }
  // Re-enable the tools which are enabled by default
  for (let node of enabledTools) {
    await toggleTool(node);
  }

  // Toggle first, middle, and last tools to ensure that toolbox tabs are
  // inserted in order
  let firstTool = toolNodes[0];
  let middleTool = toolNodes[(toolNodes.length / 2) | 0];
  let lastTool = toolNodes[toolNodes.length - 1];

  await toggleTool(firstTool);
  await toggleTool(firstTool);
  await toggleTool(middleTool);
  await toggleTool(middleTool);
  await toggleTool(lastTool);
  await toggleTool(lastTool);
}

async function toggleTool(node) {
  let deferred = defer();

  let toolId = node.getAttribute("id");
  if (node.checked) {
    gDevTools.once("tool-unregistered",
      checkUnregistered.bind(null, toolId, deferred));
  } else {
    gDevTools.once("tool-registered",
      checkRegistered.bind(null, toolId, deferred));
  }
  node.scrollIntoView();
  EventUtils.synthesizeMouseAtCenter(node, {}, panelWin);

  await deferred.promise;
}

function checkUnregistered(toolId, deferred, data) {
  if (data == toolId) {
    ok(true, "Correct tool removed");
    // checking tab on the toolbox
    ok(!doc.getElementById("toolbox-tab-" + toolId),
      "Tab removed for " + toolId);
  } else {
    ok(false, "Something went wrong, " + toolId + " was not unregistered");
  }
  deferred.resolve();
}

function checkRegistered(toolId, deferred, data) {
  if (data == toolId) {
    ok(true, "Correct tool added back");
    // checking tab on the toolbox
    let button = doc.getElementById("toolbox-tab-" + toolId);
    ok(button, "Tab added back for " + toolId);
  } else {
    ok(false, "Something went wrong, " + toolId + " was not registered");
  }
  deferred.resolve();
}

function GetPref(name) {
  let type = Services.prefs.getPrefType(name);
  switch (type) {
    case Services.prefs.PREF_STRING:
      return Services.prefs.getCharPref(name);
    case Services.prefs.PREF_INT:
      return Services.prefs.getIntPref(name);
    case Services.prefs.PREF_BOOL:
      return Services.prefs.getBoolPref(name);
    default:
      throw new Error("Unknown type");
  }
}

async function cleanup() {
  gDevTools.unregisterTool("test-tool");
  await toolbox.destroy();
  gBrowser.removeCurrentTab();
  for (let pref of modifiedPrefs) {
    Services.prefs.clearUserPref(pref);
  }
  toolbox = doc = panelWin = modifiedPrefs = null;
}
