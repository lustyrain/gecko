/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 */

var gTestserver = AddonTestUtils.createHttpServer({hosts: ["example.com"]});
gTestserver.registerDirectory("/data/", do_get_file("data"));

function load_blocklist(file, aCallback) {
  Services.obs.addObserver(function observer() {
    Services.obs.removeObserver(observer, "blocklist-updated");

    executeSoon(aCallback);
  }, "blocklist-updated");

  Services.prefs.setCharPref("extensions.blocklist.url", "http://example.com/data/" + file);
  var blocklist = Cc["@mozilla.org/extensions/blocklist;1"].
                  getService(Ci.nsITimerCallback);
  blocklist.notify(null);
}

var gSawGFX = false;
var gSawTest = false;

// Performs the initial setup
function run_test() {
  createAppInfo("xpcshell@tests.mozilla.org", "XPCShell", "3", "8");
  startupManager();

  do_test_pending();

  Services.obs.addObserver(function(aSubject, aTopic, aData) {
    Assert.ok(aSubject instanceof Ci.nsIDOMElement);
    Assert.equal(aSubject.getAttribute("testattr"), "GFX");
    Assert.equal(aSubject.childNodes.length, 2);
    gSawGFX = true;
  }, "blocklist-data-gfxItems");

  Services.obs.addObserver(function(aSubject, aTopic, aData) {
    Assert.ok(aSubject instanceof Ci.nsIDOMElement);
    Assert.equal(aSubject.getAttribute("testattr"), "FOO");
    Assert.equal(aSubject.childNodes.length, 3);
    gSawTest = true;
  }, "blocklist-data-testItems");

  Services.obs.addObserver(function(aSubject, aTopic, aData) {
    Assert.ok(gSawGFX);
    Assert.ok(gSawTest);
  }, "blocklist-data-fooItems");

  // Need to wait for the blocklist to load; Bad Things happen if the test harness
  // shuts down AddonManager before the blocklist service is done telling it about
  // changes
  load_blocklist("test_bug619730.xml", () => do_test_finished());
}
