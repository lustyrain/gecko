/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

ChromeUtils.import("resource://gre/modules/Services.jsm");
ChromeUtils.import("resource://gre/modules/XPCOMUtils.jsm");

ChromeUtils.defineModuleGetter(this, "ShellService", "resource:///modules/ShellService.jsm");
ChromeUtils.defineModuleGetter(this, "AddonManager", "resource://gre/modules/AddonManager.jsm");
ChromeUtils.defineModuleGetter(this, "TelemetryArchive", "resource://gre/modules/TelemetryArchive.jsm");
ChromeUtils.defineModuleGetter(this, "UpdateUtils", "resource://gre/modules/UpdateUtils.jsm");
ChromeUtils.defineModuleGetter(this, "NormandyApi", "resource://normandy/lib/NormandyApi.jsm");
ChromeUtils.defineModuleGetter(
    this,
    "PreferenceExperiments",
    "resource://normandy/lib/PreferenceExperiments.jsm"
);
ChromeUtils.defineModuleGetter(this, "Utils", "resource://normandy/lib/Utils.jsm");
ChromeUtils.defineModuleGetter(this, "Addons", "resource://normandy/lib/Addons.jsm");
ChromeUtils.defineModuleGetter(this, "AppConstants", "resource://gre/modules/AppConstants.jsm");

const {generateUUID} = Cc["@mozilla.org/uuid-generator;1"].getService(Ci.nsIUUIDGenerator);

var EXPORTED_SYMBOLS = ["ClientEnvironment"];

// Cached API request for client attributes that are determined by the Normandy
// service.
let _classifyRequest = null;

var ClientEnvironment = {
  /**
   * Fetches information about the client that is calculated on the server,
   * like geolocation and the current time.
   *
   * The server request is made lazily and is cached for the entire browser
   * session.
   */
  async getClientClassification() {
    if (!_classifyRequest) {
      _classifyRequest = NormandyApi.classifyClient();
    }
    return _classifyRequest;
  },

  clearClassifyCache() {
    _classifyRequest = null;
  },

  /**
   * Test wrapper that mocks the server request for classifying the client.
   * @param  {Object}   data          Fake server data to use
   * @param  {Function} testFunction  Test function to execute while mock data is in effect.
   */
  withMockClassify(data, testFunction) {
    return async function inner() {
      const oldRequest = _classifyRequest;
      _classifyRequest = Promise.resolve(data);
      await testFunction();
      _classifyRequest = oldRequest;
    };
  },

  /**
   * Create an object that provides general information about the client application.
   *
   * RecipeRunner.jsm uses this as part of the context for filter expressions,
   * so avoid adding non-getter functions as attributes, as filter expressions
   * cannot execute functions.
   *
   * Also note that, because filter expressions implicitly resolve promises, you
   * can add getter functions that return promises for async data.
   * @return {Object}
   */
  getEnvironment() {
    const environment = {};

    XPCOMUtils.defineLazyGetter(environment, "userId", () => {
      let id = Services.prefs.getCharPref("app.normandy.user_id", "");
      if (!id) {
        // generateUUID adds leading and trailing "{" and "}". strip them off.
        id = generateUUID().toString().slice(1, -1);
        Services.prefs.setCharPref("app.normandy.user_id", id);
      }
      return id;
    });

    XPCOMUtils.defineLazyGetter(environment, "country", () => {
      return ClientEnvironment.getClientClassification()
        .then(classification => classification.country);
    });

    XPCOMUtils.defineLazyGetter(environment, "request_time", () => {
      return ClientEnvironment.getClientClassification()
        .then(classification => classification.request_time);
    });

    XPCOMUtils.defineLazyGetter(environment, "distribution", () => {
      return Services.prefs.getCharPref("distribution.id", "default");
    });

    XPCOMUtils.defineLazyGetter(environment, "telemetry", async function() {
      const pings = await TelemetryArchive.promiseArchivedPingList();

      // get most recent ping per type
      const mostRecentPings = {};
      for (const ping of pings) {
        if (ping.type in mostRecentPings) {
          if (mostRecentPings[ping.type].timestampCreated < ping.timestampCreated) {
            mostRecentPings[ping.type] = ping;
          }
        } else {
          mostRecentPings[ping.type] = ping;
        }
      }

      const telemetry = {};
      for (const key in mostRecentPings) {
        const ping = mostRecentPings[key];
        telemetry[ping.type] = await TelemetryArchive.promiseArchivedPingById(ping.id);
      }
      return telemetry;
    });

    XPCOMUtils.defineLazyGetter(environment, "version", () => {
      return AppConstants.MOZ_APP_VERSION_DISPLAY;
    });

    XPCOMUtils.defineLazyGetter(environment, "channel", () => {
      return UpdateUtils.getUpdateChannel(false);
    });

    XPCOMUtils.defineLazyGetter(environment, "isDefaultBrowser", () => {
      return ShellService.isDefaultBrowser();
    });

    XPCOMUtils.defineLazyGetter(environment, "searchEngine", async function() {
      const searchInitialized = await new Promise(resolve => Services.search.init(resolve));
      if (Components.isSuccessCode(searchInitialized)) {
        return Services.search.defaultEngine.identifier;
      }
      return null;
    });

    XPCOMUtils.defineLazyGetter(environment, "syncSetup", () => {
      return Services.prefs.prefHasUserValue("services.sync.username");
    });

    XPCOMUtils.defineLazyGetter(environment, "syncDesktopDevices", () => {
      return Services.prefs.getIntPref("services.sync.clients.devices.desktop", 0);
    });

    XPCOMUtils.defineLazyGetter(environment, "syncMobileDevices", () => {
      return Services.prefs.getIntPref("services.sync.clients.devices.mobile", 0);
    });

    XPCOMUtils.defineLazyGetter(environment, "syncTotalDevices", () => {
      return environment.syncDesktopDevices + environment.syncMobileDevices;
    });

    XPCOMUtils.defineLazyGetter(environment, "plugins", async function() {
      let plugins = await AddonManager.getAddonsByTypes(["plugin"]);
      plugins = plugins.map(plugin => ({
        name: plugin.name,
        description: plugin.description,
        version: plugin.version,
      }));
      return Utils.keyBy(plugins, "name");
    });

    XPCOMUtils.defineLazyGetter(environment, "locale", () => {
      if (Services.locale.getAppLocaleAsLangTag) {
        return Services.locale.getAppLocaleAsLangTag();
      }

      return Cc["@mozilla.org/chrome/chrome-registry;1"]
        .getService(Ci.nsIXULChromeRegistry)
        .getSelectedLocale("global");
    });

    XPCOMUtils.defineLazyGetter(environment, "doNotTrack", () => {
      return Services.prefs.getBoolPref("privacy.donottrackheader.enabled", false);
    });

    XPCOMUtils.defineLazyGetter(environment, "experiments", async () => {
      const names = {all: [], active: [], expired: []};

      for (const experiment of await PreferenceExperiments.getAll()) {
        names.all.push(experiment.name);
        if (experiment.expired) {
          names.expired.push(experiment.name);
        } else {
          names.active.push(experiment.name);
        }
      }

      return names;
    });

    XPCOMUtils.defineLazyGetter(environment, "addons", async () => {
      const addons = await Addons.getAll();
      return Utils.keyBy(addons, "id");
    });

    XPCOMUtils.defineLazyGetter(environment, "isFirstRun", () => {
      return Services.prefs.getBoolPref("app.normandy.first_run", true);
    });

    return environment;
  },
};
