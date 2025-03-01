/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 */

// Tests that a reference to a non-existent extension in the registry doesn't
// break things
createAppInfo("xpcshell@tests.mozilla.org", "XPCShell", "1", "1.9.2");

// Enable loading extensions from the user and system scopes
Services.prefs.setIntPref("extensions.enabledScopes",
                          AddonManager.SCOPE_PROFILE + AddonManager.SCOPE_USER +
                          AddonManager.SCOPE_SYSTEM);

var addon1 = {
  id: "addon1@tests.mozilla.org",
  version: "1.0",
  name: "Test 1",
  bootstrap: true,
  targetApplications: [{
    id: "xpcshell@tests.mozilla.org",
    minVersion: "1",
    maxVersion: "1"
  }]
};

var addon2 = {
  id: "addon2@tests.mozilla.org",
  version: "2.0",
  name: "Test 2",
  bootstrap: true,
  targetApplications: [{
    id: "xpcshell@tests.mozilla.org",
    minVersion: "1",
    maxVersion: "2"
  }]
};

const addon1Dir = writeInstallRDFForExtension(addon1, gProfD, "addon1");
const addon2Dir = writeInstallRDFForExtension(addon2, gProfD, "addon2");
const addon3Dir = gProfD.clone();
addon3Dir.append("addon3@tests.mozilla.org");

let registry;

function run_test() {
  // This test only works where there is a registry.
  if (!("nsIWindowsRegKey" in Ci))
    return;

  registry = new MockRegistry();
  registerCleanupFunction(() => {
    registry.shutdown();
  });

  do_test_pending();

  run_test_1();
}

// Tests whether starting a fresh profile with a bad entry works
function run_test_1() {
  registry.setValue(Ci.nsIWindowsRegKey.ROOT_KEY_LOCAL_MACHINE,
                    "SOFTWARE\\Mozilla\\XPCShell\\Extensions",
                    "addon1@tests.mozilla.org", addon1Dir.path);
  registry.setValue(Ci.nsIWindowsRegKey.ROOT_KEY_CURRENT_USER,
                    "SOFTWARE\\Mozilla\\XPCShell\\Extensions",
                    "addon2@tests.mozilla.org", addon2Dir.path);
  registry.setValue(Ci.nsIWindowsRegKey.ROOT_KEY_CURRENT_USER,
                    "SOFTWARE\\Mozilla\\XPCShell\\Extensions",
                    "addon3@tests.mozilla.org", addon3Dir.path);

  startupManager();

  AddonManager.getAddonsByIDs(["addon1@tests.mozilla.org",
                               "addon2@tests.mozilla.org",
                               "addon3@tests.mozilla.org"], function([a1, a2, a3]) {
    Assert.notEqual(a1, null);
    Assert.ok(a1.isActive);
    Assert.ok(!hasFlag(a1.permissions, AddonManager.PERM_CAN_UNINSTALL));
    Assert.equal(a1.scope, AddonManager.SCOPE_SYSTEM);

    Assert.notEqual(a2, null);
    Assert.ok(a2.isActive);
    Assert.ok(!hasFlag(a2.permissions, AddonManager.PERM_CAN_UNINSTALL));
    Assert.equal(a2.scope, AddonManager.SCOPE_USER);

    Assert.equal(a3, null);

    executeSoon(run_test_2);
  });
}

// Tests whether removing the bad entry has any effect
function run_test_2() {
  shutdownManager();

  registry.setValue(Ci.nsIWindowsRegKey.ROOT_KEY_CURRENT_USER,
                    "SOFTWARE\\Mozilla\\XPCShell\\Extensions",
                    "addon3@tests.mozilla.org", addon3Dir.path);

  startupManager(false);

  AddonManager.getAddonsByIDs(["addon1@tests.mozilla.org",
                               "addon2@tests.mozilla.org",
                               "addon3@tests.mozilla.org"], function([a1, a2, a3]) {
    Assert.notEqual(a1, null);
    Assert.ok(a1.isActive);
    Assert.ok(!hasFlag(a1.permissions, AddonManager.PERM_CAN_UNINSTALL));
    Assert.equal(a1.scope, AddonManager.SCOPE_SYSTEM);

    Assert.notEqual(a2, null);
    Assert.ok(a2.isActive);
    Assert.ok(!hasFlag(a2.permissions, AddonManager.PERM_CAN_UNINSTALL));
    Assert.equal(a2.scope, AddonManager.SCOPE_USER);

    Assert.equal(a3, null);

    executeSoon(run_test_3);
  });
}

// Tests adding the bad entry to an existing profile has any effect
function run_test_3() {
  shutdownManager();

  registry.setValue(Ci.nsIWindowsRegKey.ROOT_KEY_CURRENT_USER,
                    "SOFTWARE\\Mozilla\\XPCShell\\Extensions",
                    "addon3@tests.mozilla.org", null);

  startupManager(false);

  AddonManager.getAddonsByIDs(["addon1@tests.mozilla.org",
                               "addon2@tests.mozilla.org",
                               "addon3@tests.mozilla.org"], function([a1, a2, a3]) {
    Assert.notEqual(a1, null);
    Assert.ok(a1.isActive);
    Assert.ok(!hasFlag(a1.permissions, AddonManager.PERM_CAN_UNINSTALL));
    Assert.equal(a1.scope, AddonManager.SCOPE_SYSTEM);

    Assert.notEqual(a2, null);
    Assert.ok(a2.isActive);
    Assert.ok(!hasFlag(a2.permissions, AddonManager.PERM_CAN_UNINSTALL));
    Assert.equal(a2.scope, AddonManager.SCOPE_USER);

    Assert.equal(a3, null);

    executeSoon(do_test_finished);
  });
}
