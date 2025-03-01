/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const Services = require("Services");
const osString = Services.appinfo.OS;

// Panels
loader.lazyGetter(this, "OptionsPanel", () => require("devtools/client/framework/toolbox-options").OptionsPanel);
loader.lazyGetter(this, "InspectorPanel", () => require("devtools/client/inspector/panel").InspectorPanel);
loader.lazyGetter(this, "WebConsolePanel", () => require("devtools/client/webconsole/panel").WebConsolePanel);
loader.lazyGetter(this, "DebuggerPanel", () => require("devtools/client/debugger/panel").DebuggerPanel);
loader.lazyGetter(this, "NewDebuggerPanel", () => require("devtools/client/debugger/new/panel").DebuggerPanel);
loader.lazyGetter(this, "StyleEditorPanel", () => require("devtools/client/styleeditor/styleeditor-panel").StyleEditorPanel);
loader.lazyGetter(this, "ShaderEditorPanel", () => require("devtools/client/shadereditor/panel").ShaderEditorPanel);
loader.lazyGetter(this, "CanvasDebuggerPanel", () => require("devtools/client/canvasdebugger/panel").CanvasDebuggerPanel);
loader.lazyGetter(this, "WebAudioEditorPanel", () => require("devtools/client/webaudioeditor/panel").WebAudioEditorPanel);
loader.lazyGetter(this, "MemoryPanel", () => require("devtools/client/memory/panel").MemoryPanel);
loader.lazyGetter(this, "PerformancePanel", () => require("devtools/client/performance/panel").PerformancePanel);
loader.lazyGetter(this, "NewPerformancePanel", () => require("devtools/client/performance-new/panel").PerformancePanel);
loader.lazyGetter(this, "NetMonitorPanel", () => require("devtools/client/netmonitor/panel").NetMonitorPanel);
loader.lazyGetter(this, "StoragePanel", () => require("devtools/client/storage/panel").StoragePanel);
loader.lazyGetter(this, "ScratchpadPanel", () => require("devtools/client/scratchpad/scratchpad-panel").ScratchpadPanel);
loader.lazyGetter(this, "DomPanel", () => require("devtools/client/dom/dom-panel").DomPanel);

// Other dependencies
loader.lazyRequireGetter(this, "CommandUtils", "devtools/client/shared/developer-toolbar", true);
loader.lazyRequireGetter(this, "CommandState", "devtools/shared/gcli/command-state", true);
loader.lazyRequireGetter(this, "ResponsiveUIManager", "devtools/client/responsive.html/manager", true);
loader.lazyImporter(this, "ScratchpadManager", "resource://devtools/client/scratchpad/scratchpad-manager.jsm");

const {MultiLocalizationHelper} = require("devtools/shared/l10n");
const L10N = new MultiLocalizationHelper(
  "devtools/client/locales/startup.properties",
  "devtools/startup/locales/key-shortcuts.properties"
);

var Tools = {};
exports.Tools = Tools;

// Definitions
Tools.options = {
  id: "options",
  ordinal: 0,
  url: "chrome://devtools/content/framework/toolbox-options.xhtml",
  icon: "chrome://devtools/skin/images/tool-options.svg",
  bgTheme: "theme-body",
  label: l10n("options.label"),
  iconOnly: true,
  panelLabel: l10n("options.panelLabel"),
  tooltip: l10n("optionsButton.tooltip"),
  inMenu: false,

  isTargetSupported: function() {
    return true;
  },

  build: function(iframeWindow, toolbox) {
    return new OptionsPanel(iframeWindow, toolbox);
  }
};

Tools.inspector = {
  id: "inspector",
  accesskey: l10n("inspector.accesskey"),
  ordinal: 1,
  icon: "chrome://devtools/skin/images/tool-inspector.svg",
  url: "chrome://devtools/content/inspector/inspector.xhtml",
  label: l10n("inspector.label"),
  panelLabel: l10n("inspector.panelLabel"),
  get tooltip() {
    return l10n("inspector.tooltip2",
    (osString == "Darwin" ? "Cmd+Opt+" : "Ctrl+Shift+") +
    l10n("inspector.commandkey"));
  },
  inMenu: true,
  commands: [
    "devtools/client/responsive.html/commands",
    "devtools/client/inspector/inspector-commands"
  ],

  preventClosingOnKey: true,
  onkey: function(panel, toolbox) {
    toolbox.highlighterUtils.togglePicker();
  },

  isTargetSupported: function(target) {
    return target.hasActor("inspector");
  },

  build: function(iframeWindow, toolbox) {
    return new InspectorPanel(iframeWindow, toolbox);
  }
};
Tools.webConsole = {
  id: "webconsole",
  accesskey: l10n("webConsoleCmd.accesskey"),
  ordinal: 2,
  oldWebConsoleURL: "chrome://devtools/content/webconsole/webconsole.xul",
  newWebConsoleURL: "chrome://devtools/content/webconsole/webconsole.html",
  get browserConsoleURL() {
    if (Services.prefs.getBoolPref("devtools.browserconsole.new-frontend-enabled")) {
      return "chrome://devtools/content/webconsole/browserconsole.xul";
    }
    return Tools.webConsole.oldWebConsoleURL;
  },
  icon: "chrome://devtools/skin/images/tool-webconsole.svg",
  label: l10n("ToolboxTabWebconsole.label"),
  menuLabel: l10n("MenuWebconsole.label"),
  panelLabel: l10n("ToolboxWebConsole.panelLabel"),
  get tooltip() {
    return l10n("ToolboxWebconsole.tooltip2",
    (osString == "Darwin" ? "Cmd+Opt+" : "Ctrl+Shift+") +
    l10n("webconsole.commandkey"));
  },
  inMenu: true,
  commands: "devtools/client/webconsole/console-commands",

  preventClosingOnKey: true,
  onkey: function(panel, toolbox) {
    if (toolbox.splitConsole) {
      return toolbox.focusConsoleInput();
    }

    panel.focusInput();
    return undefined;
  },

  isTargetSupported: function() {
    return true;
  },
  build: function(iframeWindow, toolbox) {
    return new WebConsolePanel(iframeWindow, toolbox);
  }
};
function switchWebconsole() {
  if (Services.prefs.getBoolPref("devtools.webconsole.new-frontend-enabled")) {
    Tools.webConsole.url = Tools.webConsole.newWebConsoleURL;
  } else {
    Tools.webConsole.url = Tools.webConsole.oldWebConsoleURL;
  }
}
switchWebconsole();

Services.prefs.addObserver(
  "devtools.webconsole.new-frontend-enabled",
  { observe: switchWebconsole }
);

Tools.jsdebugger = {
  id: "jsdebugger",
  accesskey: l10n("debuggerMenu.accesskey"),
  ordinal: 3,
  icon: "chrome://devtools/skin/images/tool-debugger.svg",
  url: "chrome://devtools/content/debugger/debugger.xul",
  label: l10n("ToolboxDebugger.label"),
  panelLabel: l10n("ToolboxDebugger.panelLabel"),
  get tooltip() {
    return l10n("ToolboxDebugger.tooltip2",
    (osString == "Darwin" ? "Cmd+Opt+" : "Ctrl+Shift+") +
    l10n("debugger.commandkey"));
  },
  inMenu: true,
  commands: "devtools/client/debugger/debugger-commands",

  isTargetSupported: function() {
    return true;
  },

  build: function(iframeWindow, toolbox) {
    return new DebuggerPanel(iframeWindow, toolbox);
  }
};

function switchDebugger() {
  if (Services.prefs.getBoolPref("devtools.debugger.new-debugger-frontend")) {
    Tools.jsdebugger.url = "chrome://devtools/content/debugger/new/index.html";
    Tools.jsdebugger.build = function(iframeWindow, toolbox) {
      return new NewDebuggerPanel(iframeWindow, toolbox);
    };
  } else {
    Tools.jsdebugger.url = "chrome://devtools/content/debugger/debugger.xul";
    Tools.jsdebugger.build = function(iframeWindow, toolbox) {
      return new DebuggerPanel(iframeWindow, toolbox);
    };
  }
}
switchDebugger();

Services.prefs.addObserver(
  "devtools.debugger.new-debugger-frontend",
  { observe: switchDebugger }
);

Tools.styleEditor = {
  id: "styleeditor",
  ordinal: 4,
  visibilityswitch: "devtools.styleeditor.enabled",
  accesskey: l10n("open.accesskey"),
  icon: "chrome://devtools/skin/images/tool-styleeditor.svg",
  url: "chrome://devtools/content/styleeditor/styleeditor.xul",
  label: l10n("ToolboxStyleEditor.label"),
  panelLabel: l10n("ToolboxStyleEditor.panelLabel"),
  get tooltip() {
    return l10n("ToolboxStyleEditor.tooltip3",
    "Shift+" + functionkey(l10n("styleeditor.commandkey")));
  },
  inMenu: true,
  commands: "devtools/client/styleeditor/styleeditor-commands",

  isTargetSupported: function(target) {
    return target.hasActor("styleSheets");
  },

  build: function(iframeWindow, toolbox) {
    return new StyleEditorPanel(iframeWindow, toolbox);
  }
};

Tools.shaderEditor = {
  id: "shadereditor",
  ordinal: 5,
  visibilityswitch: "devtools.shadereditor.enabled",
  icon: "chrome://devtools/skin/images/tool-shadereditor.svg",
  url: "chrome://devtools/content/shadereditor/shadereditor.xul",
  label: l10n("ToolboxShaderEditor.label"),
  panelLabel: l10n("ToolboxShaderEditor.panelLabel"),
  tooltip: l10n("ToolboxShaderEditor.tooltip"),

  isTargetSupported: function(target) {
    return target.hasActor("webgl") && !target.chrome;
  },

  build: function(iframeWindow, toolbox) {
    return new ShaderEditorPanel(iframeWindow, toolbox);
  }
};

Tools.canvasDebugger = {
  id: "canvasdebugger",
  ordinal: 6,
  visibilityswitch: "devtools.canvasdebugger.enabled",
  icon: "chrome://devtools/skin/images/tool-canvas.svg",
  url: "chrome://devtools/content/canvasdebugger/canvasdebugger.xul",
  label: l10n("ToolboxCanvasDebugger.label"),
  panelLabel: l10n("ToolboxCanvasDebugger.panelLabel"),
  tooltip: l10n("ToolboxCanvasDebugger.tooltip"),

  // Hide the Canvas Debugger in the Add-on Debugger and Browser Toolbox
  // (bug 1047520).
  isTargetSupported: function(target) {
    return target.hasActor("canvas") && !target.chrome;
  },

  build: function(iframeWindow, toolbox) {
    return new CanvasDebuggerPanel(iframeWindow, toolbox);
  }
};

Tools.performance = {
 id: "performance",
 ordinal: 7,
 icon: "chrome://devtools/skin/images/tool-profiler.svg",
 visibilityswitch: "devtools.performance.enabled",
 label: l10n("performance.label"),
 panelLabel: l10n("performance.panelLabel"),
 get tooltip() {
   return l10n("performance.tooltip", "Shift+" +
   functionkey(l10n("performance.commandkey")));
 },
 accesskey: l10n("performance.accesskey"),
 inMenu: true,
};

function switchPerformancePanel() {
  if (Services.prefs.getBoolPref("devtools.performance.new-panel-enabled", false)) {
    Tools.performance.url = "chrome://devtools/content/performance-new/perf.xhtml";
    Tools.performance.build = function(frame, target) {
      return new NewPerformancePanel(frame, target);
    };
    Tools.performance.isTargetSupported = function(target) {
     // Root actors are lazily initialized, so we can't check if the target has
     // the perf actor yet. Also this function is not async, so we can't initialize
     // the actor yet.
      return true;
    };
  } else {
    Tools.performance.url = "chrome://devtools/content/performance/performance.xul";
    Tools.performance.build = function(frame, target) {
      return new PerformancePanel(frame, target);
    };
    Tools.performance.isTargetSupported = function(target) {
      return target.hasActor("performance");
    };
  }
}
switchPerformancePanel();

Services.prefs.addObserver(
 "devtools.performance.new-panel-enabled",
 { observe: switchPerformancePanel }
);

Tools.memory = {
  id: "memory",
  ordinal: 8,
  icon: "chrome://devtools/skin/images/tool-memory.svg",
  url: "chrome://devtools/content/memory/memory.xhtml",
  visibilityswitch: "devtools.memory.enabled",
  label: l10n("memory.label"),
  panelLabel: l10n("memory.panelLabel"),
  tooltip: l10n("memory.tooltip"),

  isTargetSupported: function(target) {
    return target.getTrait("heapSnapshots") && !target.isAddon;
  },

  build: function(frame, target) {
    return new MemoryPanel(frame, target);
  }
};

Tools.netMonitor = {
  id: "netmonitor",
  accesskey: l10n("netmonitor.accesskey"),
  ordinal: 9,
  visibilityswitch: "devtools.netmonitor.enabled",
  icon: "chrome://devtools/skin/images/tool-network.svg",
  url: "chrome://devtools/content/netmonitor/index.html",
  label: l10n("netmonitor.label"),
  panelLabel: l10n("netmonitor.panelLabel"),
  get tooltip() {
    return l10n("netmonitor.tooltip2",
    (osString == "Darwin" ? "Cmd+Opt+" : "Ctrl+Shift+") +
    l10n("netmonitor.commandkey"));
  },
  inMenu: true,

  isTargetSupported: function(target) {
    return target.getTrait("networkMonitor");
  },

  build: function(iframeWindow, toolbox) {
    return new NetMonitorPanel(iframeWindow, toolbox);
  }
};

Tools.storage = {
  id: "storage",
  ordinal: 10,
  accesskey: l10n("storage.accesskey"),
  visibilityswitch: "devtools.storage.enabled",
  icon: "chrome://devtools/skin/images/tool-storage.svg",
  url: "chrome://devtools/content/storage/storage.xul",
  label: l10n("storage.label"),
  menuLabel: l10n("storage.menuLabel"),
  panelLabel: l10n("storage.panelLabel"),
  get tooltip() {
    return l10n("storage.tooltip3", "Shift+" +
    functionkey(l10n("storage.commandkey")));
  },
  inMenu: true,

  isTargetSupported: function(target) {
    return target.isLocalTab ||
           (target.hasActor("storage") && target.getTrait("storageInspector"));
  },

  build: function(iframeWindow, toolbox) {
    return new StoragePanel(iframeWindow, toolbox);
  }
};

Tools.webAudioEditor = {
  id: "webaudioeditor",
  ordinal: 11,
  visibilityswitch: "devtools.webaudioeditor.enabled",
  icon: "chrome://devtools/skin/images/tool-webaudio.svg",
  url: "chrome://devtools/content/webaudioeditor/webaudioeditor.xul",
  label: l10n("ToolboxWebAudioEditor1.label"),
  panelLabel: l10n("ToolboxWebAudioEditor1.panelLabel"),
  tooltip: l10n("ToolboxWebAudioEditor1.tooltip"),

  isTargetSupported: function(target) {
    return !target.chrome && target.hasActor("webaudio");
  },

  build: function(iframeWindow, toolbox) {
    return new WebAudioEditorPanel(iframeWindow, toolbox);
  }
};

Tools.scratchpad = {
  id: "scratchpad",
  ordinal: 12,
  visibilityswitch: "devtools.scratchpad.enabled",
  icon: "chrome://devtools/skin/images/tool-scratchpad.svg",
  url: "chrome://devtools/content/scratchpad/scratchpad.xul",
  label: l10n("scratchpad.label"),
  panelLabel: l10n("scratchpad.panelLabel"),
  tooltip: l10n("scratchpad.tooltip"),
  inMenu: false,
  commands: "devtools/client/scratchpad/scratchpad-commands",

  isTargetSupported: function(target) {
    return target.hasActor("console");
  },

  build: function(iframeWindow, toolbox) {
    return new ScratchpadPanel(iframeWindow, toolbox);
  }
};

Tools.dom = {
  id: "dom",
  accesskey: l10n("dom.accesskey"),
  ordinal: 13,
  visibilityswitch: "devtools.dom.enabled",
  icon: "chrome://devtools/skin/images/tool-dom.svg",
  url: "chrome://devtools/content/dom/dom.html",
  label: l10n("dom.label"),
  panelLabel: l10n("dom.panelLabel"),
  get tooltip() {
    return l10n("dom.tooltip",
      (osString == "Darwin" ? "Cmd+Opt+" : "Ctrl+Shift+") +
      l10n("dom.commandkey"));
  },
  inMenu: true,

  isTargetSupported: function(target) {
    return target.getTrait("webConsoleCommands");
  },

  build: function(iframeWindow, toolbox) {
    return new DomPanel(iframeWindow, toolbox);
  }
};

var defaultTools = [
  Tools.options,
  Tools.webConsole,
  Tools.inspector,
  Tools.jsdebugger,
  Tools.styleEditor,
  Tools.shaderEditor,
  Tools.canvasDebugger,
  Tools.webAudioEditor,
  Tools.performance,
  Tools.netMonitor,
  Tools.storage,
  Tools.scratchpad,
  Tools.memory,
  Tools.dom,
];

exports.defaultTools = defaultTools;

Tools.darkTheme = {
  id: "dark",
  label: l10n("options.darkTheme.label2"),
  ordinal: 1,
  stylesheets: ["chrome://devtools/skin/dark-theme.css"],
  classList: ["theme-dark"],
};

Tools.lightTheme = {
  id: "light",
  label: l10n("options.lightTheme.label2"),
  ordinal: 2,
  stylesheets: ["chrome://devtools/skin/light-theme.css"],
  classList: ["theme-light"],
};

Tools.firebugTheme = {
  id: "firebug",
  label: l10n("options.firebugTheme.label2"),
  ordinal: 3,
  stylesheets: ["chrome://devtools/skin/firebug-theme.css"],
  classList: ["theme-light", "theme-firebug"],
};

exports.defaultThemes = [
  Tools.darkTheme,
  Tools.lightTheme,
  Tools.firebugTheme,
];

// White-list buttons that can be toggled to prevent adding prefs for
// addons that have manually inserted toolbarbuttons into DOM.
// (By default, supported target is only local tab)
exports.ToolboxButtons = [
  { id: "command-button-splitconsole",
    description: l10n("toolbox.buttons.splitconsole", "Esc"),
    isTargetSupported: target => !target.isAddon,
    onClick(event, toolbox) {
      toolbox.toggleSplitConsole();
    },
    isChecked(toolbox) {
      return toolbox.splitConsole;
    },
    setup(toolbox, onChange) {
      toolbox.on("split-console", onChange);
    },
    teardown(toolbox, onChange) {
      toolbox.off("split-console", onChange);
    }
  },
  { id: "command-button-paintflashing",
    description: l10n("toolbox.buttons.paintflashing"),
    isTargetSupported: target => target.isLocalTab,
    onClick(event, toolbox) {
      CommandUtils.executeOnTarget(toolbox.target, "paintflashing toggle");
    },
    isChecked(toolbox) {
      return CommandState.isEnabledForTarget(toolbox.target, "paintflashing");
    },
    setup(toolbox, onChange) {
      CommandState.on("changed", onChange);
    },
    teardown(toolbox, onChange) {
      CommandState.off("changed", onChange);
    }
  },
  { id: "command-button-scratchpad",
    description: l10n("toolbox.buttons.scratchpad"),
    isTargetSupported: target => target.isLocalTab,
    onClick(event, toolbox) {
      ScratchpadManager.openScratchpad();
    }
  },
  { id: "command-button-responsive",
    description: l10n("toolbox.buttons.responsive",
                      osString == "Darwin" ? "Cmd+Opt+M" : "Ctrl+Shift+M"),
    isTargetSupported: target => target.isLocalTab,
    onClick(event, toolbox) {
      let tab = toolbox.target.tab;
      let browserWindow = tab.ownerDocument.defaultView;
      ResponsiveUIManager.handleGcliCommand(browserWindow, tab,
        "resize toggle", null);
    },
    isChecked(toolbox) {
      if (!toolbox.target.tab) {
        return false;
      }
      return ResponsiveUIManager.isActiveForTab(toolbox.target.tab);
    },
    setup(toolbox, onChange) {
      ResponsiveUIManager.on("on", onChange);
      ResponsiveUIManager.on("off", onChange);
    },
    teardown(toolbox, onChange) {
      ResponsiveUIManager.off("on", onChange);
      ResponsiveUIManager.off("off", onChange);
    }
  },
  { id: "command-button-screenshot",
    description: l10n("toolbox.buttons.screenshot"),
    isTargetSupported: target => target.isLocalTab,
    onClick(event, toolbox) {
      // Special case for screenshot button to check for clipboard preference
      const clipboardEnabled = Services.prefs
        .getBoolPref("devtools.screenshot.clipboard.enabled");
      let args = "--fullpage --file";
      if (clipboardEnabled) {
        args += " --clipboard";
      }
      CommandUtils.executeOnTarget(toolbox.target, "screenshot " + args);
    }
  },
  { id: "command-button-rulers",
    description: l10n("toolbox.buttons.rulers"),
    isTargetSupported: target => target.isLocalTab,
    onClick(event, toolbox) {
      CommandUtils.executeOnTarget(toolbox.target, "rulers");
    },
    isChecked(toolbox) {
      return CommandState.isEnabledForTarget(toolbox.target, "rulers");
    },
    setup(toolbox, onChange) {
      CommandState.on("changed", onChange);
    },
    teardown(toolbox, onChange) {
      CommandState.off("changed", onChange);
    }
  },
  { id: "command-button-measure",
    description: l10n("toolbox.buttons.measure"),
    isTargetSupported: target => target.isLocalTab,
    onClick(event, toolbox) {
      CommandUtils.executeOnTarget(toolbox.target, "measure");
    },
    isChecked(toolbox) {
      return CommandState.isEnabledForTarget(toolbox.target, "measure");
    },
    setup(toolbox, onChange) {
      CommandState.on("changed", onChange);
    },
    teardown(toolbox, onChange) {
      CommandState.off("changed", onChange);
    }
  },
];

/**
 * Lookup l10n string from a string bundle.
 *
 * @param {string} name
 *        The key to lookup.
 * @param {string} arg
 *        Optional format argument.
 * @returns A localized version of the given key.
 */
function l10n(name, arg) {
  try {
    return arg ? L10N.getFormatStr(name, arg) : L10N.getStr(name);
  } catch (ex) {
    console.log("Error reading '" + name + "'");
    throw new Error("l10n error with " + name);
  }
}

function functionkey(shortkey) {
  return shortkey.split("_")[1];
}
