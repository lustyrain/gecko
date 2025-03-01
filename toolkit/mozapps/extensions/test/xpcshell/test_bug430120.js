/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

const BLOCKLIST_TIMER                 = "blocklist-background-update-timer";
const PREF_BLOCKLIST_URL              = "extensions.blocklist.url";
const PREF_BLOCKLIST_ENABLED          = "extensions.blocklist.enabled";
const PREF_APP_DISTRIBUTION           = "distribution.id";
const PREF_APP_DISTRIBUTION_VERSION   = "distribution.version";
const PREF_APP_UPDATE_CHANNEL         = "app.update.channel";
const CATEGORY_UPDATE_TIMER           = "update-timer";

// Get the HTTP server.
ChromeUtils.import("resource://testing-common/httpd.js");
ChromeUtils.import("resource://testing-common/MockRegistrar.jsm");
var testserver;
var gOSVersion;
var gBlocklist;

// This is a replacement for the timer service so we can trigger timers
var timerService = {

  hasTimer(id) {
    var catMan = Cc["@mozilla.org/categorymanager;1"]
                   .getService(Ci.nsICategoryManager);
    var entries = catMan.enumerateCategory(CATEGORY_UPDATE_TIMER);
    while (entries.hasMoreElements()) {
      var entry = entries.getNext().QueryInterface(Ci.nsISupportsCString).data;
      var value = catMan.getCategoryEntry(CATEGORY_UPDATE_TIMER, entry);
      var timerID = value.split(",")[2];
      if (id == timerID) {
        return true;
      }
    }
    return false;
  },

  fireTimer(id) {
    gBlocklist.QueryInterface(Ci.nsITimerCallback).notify(null);
  },

  QueryInterface(iid) {
    if (iid.equals(Ci.nsIUpdateTimerManager)
     || iid.equals(Ci.nsISupports))
      return this;

    throw Cr.NS_ERROR_NO_INTERFACE;
  }
};

MockRegistrar.register("@mozilla.org/updates/timer-manager;1", timerService);

function failHandler(metadata, response) {
  do_throw("Should not have attempted to retrieve the blocklist when it is disabled");
}

function pathHandler(metadata, response) {
  var ABI = "noarch-spidermonkey";
  // the blacklist service special-cases ABI for Universal binaries,
  // so do the same here.
  if ("@mozilla.org/xpcom/mac-utils;1" in Cc) {
    var macutils = Cc["@mozilla.org/xpcom/mac-utils;1"]
                     .getService(Ci.nsIMacUtils);
    if (macutils.isUniversalBinary)
      ABI += "-u-" + macutils.architecturesInBinary;
  }
  Assert.equal(metadata.queryString,
               "xpcshell@tests.mozilla.org&1&XPCShell&1&" +
               gAppInfo.appBuildID + "&" +
               "XPCShell_" + ABI + "&locale&updatechannel&" +
               gOSVersion + "&1.9&distribution&distribution-version");
  gBlocklist.observe(null, "quit-application", "");
  gBlocklist.observe(null, "xpcom-shutdown", "");
  do_test_finished();
}

function run_test() {
  var osVersion;
  try {
    osVersion = Services.sysinfo.getProperty("name") + " " + Services.sysinfo.getProperty("version");
    if (osVersion) {
      try {
        osVersion += " (" + Services.sysinfo.getProperty("secondaryLibrary") + ")";
      } catch (e) {
      }
      gOSVersion = encodeURIComponent(osVersion);
    }
  } catch (e) {
  }

  createAppInfo("xpcshell@tests.mozilla.org", "XPCShell", "1", "1.9");

  testserver = AddonTestUtils.createHttpServer({hosts: ["example.com"]});
  testserver.registerPathHandler("/1", failHandler);
  testserver.registerPathHandler("/2", pathHandler);

  // Initialise the blocklist service
  gBlocklist = Services.blocklist.QueryInterface(Ci.nsIObserver);
  gBlocklist.observe(null, "profile-after-change", "");

  Assert.ok(timerService.hasTimer(BLOCKLIST_TIMER));

  do_test_pending();

  // This should have no effect as the blocklist is disabled
  Services.prefs.setCharPref(PREF_BLOCKLIST_URL, "http://example.com/1");
  Services.prefs.setBoolPref(PREF_BLOCKLIST_ENABLED, false);
  timerService.fireTimer(BLOCKLIST_TIMER);

  // Some values have to be on the default branch to work
  var defaults = Services.prefs.QueryInterface(Ci.nsIPrefService)
                       .getDefaultBranch(null);
  defaults.setCharPref(PREF_APP_UPDATE_CHANNEL, "updatechannel");
  defaults.setCharPref(PREF_APP_DISTRIBUTION, "distribution");
  defaults.setCharPref(PREF_APP_DISTRIBUTION_VERSION, "distribution-version");
  Services.locale.setRequestedLocales(["locale"]);

  // This should correctly escape everything
  Services.prefs.setCharPref(PREF_BLOCKLIST_URL, "http://example.com/2?" +
                     "%APP_ID%&%APP_VERSION%&%PRODUCT%&%VERSION%&%BUILD_ID%&" +
                     "%BUILD_TARGET%&%LOCALE%&%CHANNEL%&" +
                     "%OS_VERSION%&%PLATFORM_VERSION%&%DISTRIBUTION%&%DISTRIBUTION_VERSION%");
  Services.prefs.setBoolPref(PREF_BLOCKLIST_ENABLED, true);
  timerService.fireTimer(BLOCKLIST_TIMER);
}
