/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

// Disables security checking our updates which haven't been signed
Services.prefs.setBoolPref("extensions.checkUpdateSecurity", false);

ChromeUtils.import("resource://testing-common/MockRegistrar.jsm");

// This is the data we expect to see sent as part of the update url.
var EXPECTED = [
  {
    id: "bug335238_1@tests.mozilla.org",
    version: "1.3.4",
    maxAppVersion: "5",
    status: "userEnabled",
    appId: "xpcshell@tests.mozilla.org",
    appVersion: "1",
    appOs: "XPCShell",
    appAbi: "noarch-spidermonkey",
    locale: "en-US",
    reqVersion: "2"
  },
  {
    id: "bug335238_2@tests.mozilla.org",
    version: "28at",
    maxAppVersion: "7",
    status: "userDisabled",
    appId: "xpcshell@tests.mozilla.org",
    appVersion: "1",
    appOs: "XPCShell",
    appAbi: "noarch-spidermonkey",
    locale: "en-US",
    reqVersion: "2"
  },
  {
    id: "bug335238_3@tests.mozilla.org",
    version: "58",
    maxAppVersion: "*",
    status: "userDisabled,softblocked",
    appId: "xpcshell@tests.mozilla.org",
    appVersion: "1",
    appOs: "XPCShell",
    appAbi: "noarch-spidermonkey",
    locale: "en-US",
    reqVersion: "2"
  },
  {
    id: "bug335238_4@tests.mozilla.org",
    version: "4",
    maxAppVersion: "2+",
    status: "userEnabled,blocklisted",
    appId: "xpcshell@tests.mozilla.org",
    appVersion: "1",
    appOs: "XPCShell",
    appAbi: "noarch-spidermonkey",
    locale: "en-US",
    reqVersion: "2"
  }
];

const MANIFESTS = [
  {
    id: "bug335238_1@tests.mozilla.org",
    version: "1.3.4",
    name: "Bug 335238",
    updateURL: "http://example.com/0?id=%ITEM_ID%&version=%ITEM_VERSION%&maxAppVersion=%ITEM_MAXAPPVERSION%&status=%ITEM_STATUS%&appId=%APP_ID%&appVersion=%APP_VERSION%&appOs=%APP_OS%&appAbi=%APP_ABI%&locale=%APP_LOCALE%&reqVersion=%REQ_VERSION%",
    bootstrap: true,

    targetApplications: [{
        id: "xpcshell@tests.mozilla.org",
        minVersion: "1",
        maxVersion: "5"}],
  },
  {
    id: "bug335238_2@tests.mozilla.org",
    version: "28at",
    name: "Bug 335238",
    updateURL: "http://example.com/1?id=%ITEM_ID%&version=%ITEM_VERSION%&maxAppVersion=%ITEM_MAXAPPVERSION%&status=%ITEM_STATUS%&appId=%APP_ID%&appVersion=%APP_VERSION%&appOs=%APP_OS%&appAbi=%APP_ABI%&locale=%APP_LOCALE%&reqVersion=%REQ_VERSION%",
    bootstrap: true,

    targetApplications: [{
      id: "xpcshell@tests.mozilla.org",
      minVersion: "1",
      maxVersion: "7"}],
  },
  {
    id: "bug335238_3@tests.mozilla.org",
    version: "58",
    name: "Bug 335238",
    updateURL: "http://example.com/2?id=%ITEM_ID%&version=%ITEM_VERSION%&maxAppVersion=%ITEM_MAXAPPVERSION%&status=%ITEM_STATUS%&appId=%APP_ID%&appVersion=%APP_VERSION%&appOs=%APP_OS%&appAbi=%APP_ABI%&locale=%APP_LOCALE%&reqVersion=%REQ_VERSION%",
    bootstrap: true,

    targetApplications: [{
        id: "xpcshell@tests.mozilla.org",
        minVersion: "1",
        maxVersion: "*"}],
  },
  {
    id: "bug335238_4@tests.mozilla.org",
    version: "4",
    name: "Bug 335238",
    updateURL: "http://example.com/3?id=%ITEM_ID%&version=%ITEM_VERSION%&maxAppVersion=%ITEM_MAXAPPVERSION%&status=%ITEM_STATUS%&appId=%APP_ID%&appVersion=%APP_VERSION%&appOs=%APP_OS%&appAbi=%APP_ABI%&locale=%APP_LOCALE%&reqVersion=%REQ_VERSION%",
    bootstrap: true,

    targetApplications: [{
        id: "xpcshell@tests.mozilla.org",
        minVersion: "1",
        maxVersion: "2+"}],
  },
];

const XPIS = MANIFESTS.map(manifest => createTempXPIFile(manifest));

var ADDONS = [
  {id: "bug335238_1@tests.mozilla.org",
   addon: XPIS[0]},
  {id: "bug335238_2@tests.mozilla.org",
   addon: XPIS[1]},
  {id: "bug335238_3@tests.mozilla.org",
   addon: XPIS[2]},
  {id: "bug335238_4@tests.mozilla.org",
   addon: XPIS[3]}
];

// This is a replacement for the blocklist service
var BlocklistService = {
  getAddonBlocklistState(aAddon, aAppVersion, aToolkitVersion) {
    if (aAddon.id == "bug335238_3@tests.mozilla.org")
      return Ci.nsIBlocklistService.STATE_SOFTBLOCKED;
    if (aAddon.id == "bug335238_4@tests.mozilla.org")
      return Ci.nsIBlocklistService.STATE_BLOCKED;
    return Ci.nsIBlocklistService.STATE_NOT_BLOCKED;
  },

  getAddonBlocklistEntry(aAddon, aAppVersion, aToolkitVersion) {
    let state = this.getAddonBlocklistState(aAddon, aAppVersion, aToolkitVersion);
    if (state != Ci.nsIBlocklistService.STATE_NOT_BLOCKED) {
      return {
        state,
        url: "http://example.com/",
      };
    }
    return null;
  },

  getPluginBlocklistState(aPlugin, aVersion, aAppVersion, aToolkitVersion) {
    return Ci.nsIBlocklistService.STATE_NOT_BLOCKED;
  },

  isAddonBlocklisted(aAddon, aAppVersion, aToolkitVersion) {
    return this.getAddonBlocklistState(aAddon, aAppVersion, aToolkitVersion) ==
           Ci.nsIBlocklistService.STATE_BLOCKED;
  },

  QueryInterface(iid) {
    if (iid.equals(Ci.nsIBlocklistService)
     || iid.equals(Ci.nsISupports))
      return this;

    throw Cr.NS_ERROR_NO_INTERFACE;
  }
};

MockRegistrar.register("@mozilla.org/extensions/blocklist;1", BlocklistService);

var server;

var updateListener = {
  pendingCount: 0,

  onUpdateAvailable(aAddon) {
    do_throw("Should not have seen an update for " + aAddon.id);
  },

  onUpdateFinished() {
    if (--this.pendingCount == 0)
      do_test_finished();
  }
};

var requestHandler = {
  handle(metadata, response) {
    var expected = EXPECTED[metadata.path.substring(1)];
    var params = metadata.queryString.split("&");
    Assert.equal(params.length, 10);
    for (var k in params) {
      var pair = params[k].split("=");
      var name = decodeURIComponent(pair[0]);
      var value = decodeURIComponent(pair[1]);
      Assert.equal(expected[name], value);
    }
    response.setStatusLine(metadata.httpVersion, 404, "Not Found");
  }
};

function run_test() {
  do_test_pending();
  createAppInfo("xpcshell@tests.mozilla.org", "XPCShell", "1", "1.9");

  server = AddonTestUtils.createHttpServer({hosts: ["example.com"]});
  server.registerPathHandler("/0", requestHandler);
  server.registerPathHandler("/1", requestHandler);
  server.registerPathHandler("/2", requestHandler);
  server.registerPathHandler("/3", requestHandler);

  Services.locale.setRequestedLocales(["en-US"]);

  startupManager();
  installAllFiles(ADDONS.map(a => a.addon), function() {

    restartManager();
    AddonManager.getAddonByID(ADDONS[1].id, callback_soon(function(addon) {
      Assert.ok(!(!addon));
      addon.userDisabled = true;
      restartManager();

      AddonManager.getAddonsByIDs(ADDONS.map(a => a.id), function(installedItems) {
        installedItems.forEach(function(item) {
          updateListener.pendingCount++;
          item.findUpdates(updateListener, AddonManager.UPDATE_WHEN_USER_REQUESTED);
        });
      });
    }));
  });
}
