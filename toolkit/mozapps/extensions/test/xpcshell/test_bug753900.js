/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 */

// This verifies that strange characters in an add-on version don't break the
// crash annotation.

var addon3 = {
  id: "addon3@tests.mozilla.org",
  version: "1,0",
  name: "Test 3",
  bootstrap: true,
  targetApplications: [{
    id: "xpcshell@tests.mozilla.org",
    minVersion: "1",
    maxVersion: "1"
  }]
};

var addon4 = {
  id: "addon4@tests.mozilla.org",
  version: "1:0",
  name: "Test 4",
  bootstrap: true,
  targetApplications: [{
    id: "xpcshell@tests.mozilla.org",
    minVersion: "1",
    maxVersion: "1"
  }]
};

createAppInfo("xpcshell@tests.mozilla.org", "XPCShell", "1", "1.9.2");

const profileDir = gProfD.clone();
profileDir.append("extensions");

function run_test() {
  do_test_pending();

  writeInstallRDFForExtension(addon3, profileDir);
  writeInstallRDFForExtension(addon4, profileDir);

  startupManager();

  AddonManager.getAddonsByIDs(["addon3@tests.mozilla.org",
                               "addon4@tests.mozilla.org"],
                               function([a3, a4]) {

    Assert.notEqual(a3, null);
    do_check_in_crash_annotation(addon3.id, addon3.version);
    Assert.notEqual(a4, null);
    do_check_in_crash_annotation(addon4.id, addon4.version);

    executeSoon(do_test_finished);
  });
}
