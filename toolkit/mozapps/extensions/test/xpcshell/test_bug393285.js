/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

const URI_EXTENSION_BLOCKLIST_DIALOG = "chrome://mozapps/content/extensions/blocklist.xul";

ChromeUtils.import("resource://testing-common/MockRegistrar.jsm");
var testserver = AddonTestUtils.createHttpServer({hosts: ["example.com"]});
gPort = testserver.identity.primaryPort;

testserver.registerDirectory("/data/", do_get_file("data"));

const profileDir = gProfD.clone();
profileDir.append("extensions");

var addonIDs = ["test_bug393285_1@tests.mozilla.org",
                "test_bug393285_2@tests.mozilla.org",
                "test_bug393285_3a@tests.mozilla.org",
                "test_bug393285_3b@tests.mozilla.org",
                "test_bug393285_4@tests.mozilla.org",
                "test_bug393285_5@tests.mozilla.org",
                "test_bug393285_6@tests.mozilla.org",
                "test_bug393285_7@tests.mozilla.org",
                "test_bug393285_8@tests.mozilla.org",
                "test_bug393285_9@tests.mozilla.org",
                "test_bug393285_10@tests.mozilla.org",
                "test_bug393285_11@tests.mozilla.org",
                "test_bug393285_12@tests.mozilla.org",
                "test_bug393285_13@tests.mozilla.org",
                "test_bug393285_14@tests.mozilla.org"];

// A window watcher to deal with the blocklist UI dialog.
var WindowWatcher = {
  openWindow(parent, url, name, features, args) {
    // Should be called to list the newly blocklisted items
    Assert.equal(url, URI_EXTENSION_BLOCKLIST_DIALOG);

    // Simulate auto-disabling any softblocks
    var list = args.wrappedJSObject.list;
    list.forEach(function(aItem) {
      if (!aItem.blocked)
        aItem.disable = true;
    });

    // run the code after the blocklist is closed
    Services.obs.notifyObservers(null, "addon-blocklist-closed");

  },

  QueryInterface(iid) {
    if (iid.equals(Ci.nsIWindowWatcher)
     || iid.equals(Ci.nsISupports))
      return this;

    throw Cr.NS_ERROR_NO_INTERFACE;
  }
};

MockRegistrar.register("@mozilla.org/embedcomp/window-watcher;1", WindowWatcher);


function load_blocklist(aFile, aCallback) {
  Services.obs.addObserver(function observer() {
    Services.obs.removeObserver(observer, "blocklist-updated");

    executeSoon(aCallback);
  }, "blocklist-updated");

  Services.prefs.setCharPref("extensions.blocklist.url", "http://localhost:" +
                             gPort + "/data/" + aFile);
  var blocklist = Cc["@mozilla.org/extensions/blocklist;1"].
                  getService(Ci.nsITimerCallback);
  blocklist.notify(null);
}


function end_test() {
  do_test_finished();
}

function run_test() {
  do_test_pending();

  createAppInfo("xpcshell@tests.mozilla.org", "XPCShell", "1", "1.9");

  writeInstallRDFForExtension({
    id: "test_bug393285_1@tests.mozilla.org",
    name: "extension 1",
    bootstrap: true,
    version: "1.0",
    targetApplications: [{
      id: "xpcshell@tests.mozilla.org",
      minVersion: "1",
      maxVersion: "3"
    }]
  }, profileDir);


  writeInstallRDFForExtension({
    id: "test_bug393285_2@tests.mozilla.org",
    name: "extension 2",
    bootstrap: true,
    version: "1.0",
    targetApplications: [{
      id: "xpcshell@tests.mozilla.org",
      minVersion: "1",
      maxVersion: "3"
    }]
  }, profileDir);

  writeInstallRDFForExtension({
    id: "test_bug393285_3a@tests.mozilla.org",
    name: "extension 3a",
    bootstrap: true,
    version: "1.0",
    targetApplications: [{
      id: "xpcshell@tests.mozilla.org",
      minVersion: "1",
      maxVersion: "3"
    }]
  }, profileDir);

  writeInstallRDFForExtension({
    id: "test_bug393285_3b@tests.mozilla.org",
    name: "extension 3b",
    bootstrap: true,
    version: "2.0",
    targetApplications: [{
      id: "xpcshell@tests.mozilla.org",
      minVersion: "1",
      maxVersion: "3"
    }]
  }, profileDir);

  writeInstallRDFForExtension({
    id: "test_bug393285_4@tests.mozilla.org",
    name: "extension 4",
    bootstrap: true,
    version: "1.0",
    targetApplications: [{
      id: "xpcshell@tests.mozilla.org",
      minVersion: "1",
      maxVersion: "3"
    }]
  }, profileDir);

  writeInstallRDFForExtension({
    id: "test_bug393285_5@tests.mozilla.org",
    name: "extension 5",
    bootstrap: true,
    version: "1.0",
    targetApplications: [{
      id: "xpcshell@tests.mozilla.org",
      minVersion: "1",
      maxVersion: "3"
    }]
  }, profileDir);

  writeInstallRDFForExtension({
    id: "test_bug393285_6@tests.mozilla.org",
    name: "extension 6",
    bootstrap: true,
    version: "1.0",
    targetApplications: [{
      id: "xpcshell@tests.mozilla.org",
      minVersion: "1",
      maxVersion: "3"
    }]
  }, profileDir);

  writeInstallRDFForExtension({
    id: "test_bug393285_7@tests.mozilla.org",
    name: "extension 7",
    bootstrap: true,
    version: "1.0",
    targetApplications: [{
      id: "xpcshell@tests.mozilla.org",
      minVersion: "1",
      maxVersion: "3"
    }]
  }, profileDir);

  writeInstallRDFForExtension({
    id: "test_bug393285_8@tests.mozilla.org",
    name: "extension 8",
    bootstrap: true,
    version: "1.0",
    targetApplications: [{
      id: "xpcshell@tests.mozilla.org",
      minVersion: "1",
      maxVersion: "3"
    }]
  }, profileDir);

  writeInstallRDFForExtension({
    id: "test_bug393285_9@tests.mozilla.org",
    name: "extension 9",
    bootstrap: true,
    version: "1.0",
    targetApplications: [{
      id: "xpcshell@tests.mozilla.org",
      minVersion: "1",
      maxVersion: "3"
    }]
  }, profileDir);

  writeInstallRDFForExtension({
    id: "test_bug393285_10@tests.mozilla.org",
    name: "extension 10",
    bootstrap: true,
    version: "1.0",
    targetApplications: [{
      id: "xpcshell@tests.mozilla.org",
      minVersion: "1",
      maxVersion: "3"
    }]
  }, profileDir);

  writeInstallRDFForExtension({
    id: "test_bug393285_11@tests.mozilla.org",
    name: "extension 11",
    bootstrap: true,
    version: "1.0",
    targetApplications: [{
      id: "xpcshell@tests.mozilla.org",
      minVersion: "1",
      maxVersion: "3"
    }]
  }, profileDir);

  writeInstallRDFForExtension({
    id: "test_bug393285_12@tests.mozilla.org",
    name: "extension 12",
    bootstrap: true,
    version: "1.0",
    targetApplications: [{
      id: "xpcshell@tests.mozilla.org",
      minVersion: "1",
      maxVersion: "3"
    }]
  }, profileDir);

  writeInstallRDFForExtension({
    id: "test_bug393285_13@tests.mozilla.org",
    name: "extension 13",
    bootstrap: true,
    version: "1.0",
    targetApplications: [{
      id: "xpcshell@tests.mozilla.org",
      minVersion: "1",
      maxVersion: "3"
    }]
  }, profileDir);

  writeInstallRDFForExtension({
    id: "test_bug393285_14@tests.mozilla.org",
    name: "extension 14",
    bootstrap: true,
    version: "1.0",
    targetApplications: [{
      id: "xpcshell@tests.mozilla.org",
      minVersion: "1",
      maxVersion: "3"
    }]
  }, profileDir);

  startupManager();

  AddonManager.getAddonsByIDs(addonIDs, function(addons) {
    for (let addon of addons) {
      Assert.equal(addon.blocklistState, Ci.nsIBlocklistService.STATE_NOT_BLOCKED);
    }
    run_test_1();
  });
}

function run_test_1() {
  load_blocklist("test_bug393285.xml", function() {
    restartManager();

    AddonManager.getAddonsByIDs(addonIDs,
                               function([a1, a2, a3, a4, a5, a6, a7, a8, a9, a10,
                                         a11, a12, a13, a14, a15]) {
      // No info in blocklist, shouldn't be blocked
      Assert.ok(!Services.blocklist.isAddonBlocklisted(a1, "1", "1.9"));

      // Should always be blocked
      Assert.ok(Services.blocklist.isAddonBlocklisted(a2, "1", "1.9"));

      // Only version 1 should be blocked
      Assert.ok(Services.blocklist.isAddonBlocklisted(a3, "1", "1.9"));
      Assert.ok(!Services.blocklist.isAddonBlocklisted(a4, "1", "1.9"));

      // Should be blocked for app version 1
      Assert.ok(Services.blocklist.isAddonBlocklisted(a5, "1", "1.9"));
      Assert.ok(!Services.blocklist.isAddonBlocklisted(a5, "2", "1.9"));

      // Not blocklisted because we are a different OS
      Assert.ok(!Services.blocklist.isAddonBlocklisted(a6, "2", "1.9"));

      // Blocklisted based on OS
      Assert.ok(Services.blocklist.isAddonBlocklisted(a7, "2", "1.9"));
      Assert.ok(Services.blocklist.isAddonBlocklisted(a8, "2", "1.9"));

      // Not blocklisted because we are a different ABI
      Assert.ok(!Services.blocklist.isAddonBlocklisted(a9, "2", "1.9"));

      // Blocklisted based on ABI
      Assert.ok(Services.blocklist.isAddonBlocklisted(a10, "2", "1.9"));
      Assert.ok(Services.blocklist.isAddonBlocklisted(a11, "2", "1.9"));

      // Doesnt match both os and abi so not blocked
      Assert.ok(!Services.blocklist.isAddonBlocklisted(a12, "2", "1.9"));
      Assert.ok(!Services.blocklist.isAddonBlocklisted(a13, "2", "1.9"));
      Assert.ok(!Services.blocklist.isAddonBlocklisted(a14, "2", "1.9"));

      // Matches both os and abi so blocked
      Assert.ok(Services.blocklist.isAddonBlocklisted(a15, "2", "1.9"));
      end_test();
    });
  });
}
