const CLASS_ID = Components.ID("{12345678-1234-1234-1234-123456789abc}");
const CONTRACT_ID = "@mozilla.org/test-parameter-source;1";

var testserver = AddonTestUtils.createHttpServer({hosts: ["example.com"]});

var gTestURL = "http://example.com/update.json?itemID=%ITEM_ID%&custom1=%CUSTOM1%&custom2=%CUSTOM2%";
var gExpectedQuery = "itemID=test@mozilla.org&custom1=custom_parameter_1&custom2=custom_parameter_2";
var gSeenExpectedURL = false;

var gComponentRegistrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
var gCategoryManager = Cc["@mozilla.org/categorymanager;1"].getService(Ci.nsICategoryManager);

// Factory for our parameter handler
var paramHandlerFactory = {
  QueryInterface(iid) {
    if (iid.equals(Ci.nsIFactory) || iid.equals(Ci.nsISupports))
      return this;

    throw Cr.NS_ERROR_NO_INTERFACE;
  },

  createInstance(outer, iid) {
    var bag = Cc["@mozilla.org/hash-property-bag;1"].
              createInstance(Ci.nsIWritablePropertyBag);
    bag.setProperty("CUSTOM1", "custom_parameter_1");
    bag.setProperty("CUSTOM2", "custom_parameter_2");
    return bag.QueryInterface(iid);
  }
};

function initTest() {
  do_test_pending();
  // Setup extension manager
  createAppInfo("xpcshell@tests.mozilla.org", "XPCShell", "1", "1.9");

  // Configure the HTTP server.
  testserver.registerPathHandler("/update.json", function(aRequest, aResponse) {
    gSeenExpectedURL = aRequest.queryString == gExpectedQuery;
    aResponse.setStatusLine(null, 404, "Not Found");
  });

  // Register our parameter handlers
  gComponentRegistrar.registerFactory(CLASS_ID, "Test component", CONTRACT_ID, paramHandlerFactory);
  gCategoryManager.addCategoryEntry("extension-update-params", "CUSTOM1", CONTRACT_ID, false, false);
  gCategoryManager.addCategoryEntry("extension-update-params", "CUSTOM2", CONTRACT_ID, false, false);

  // Install a test extension into the profile
  let dir = gProfD.clone();
  dir.append("extensions");
  writeInstallRDFForExtension({
    id: "test@mozilla.org",
    version: "1.0",
    name: "Test extension",
    bootstrap: true,
    updateURL: gTestURL,
    targetApplications: [{
      id: "xpcshell@tests.mozilla.org",
      minVersion: "1",
      maxVersion: "1"
    }],
  }, dir);

  startupManager();
}

function shutdownTest() {
  shutdownManager();

  gComponentRegistrar.unregisterFactory(CLASS_ID, paramHandlerFactory);
  gCategoryManager.deleteCategoryEntry("extension-update-params", "CUSTOM1", false);
  gCategoryManager.deleteCategoryEntry("extension-update-params", "CUSTOM2", false);

  do_test_finished();
}

function run_test() {
  initTest();

  AddonManager.getAddonByID("test@mozilla.org", function(item) {
    // Initiate update
    item.findUpdates({
      onCompatibilityUpdateAvailable(addon) {
        do_throw("Should not have seen a compatibility update");
      },

      onUpdateAvailable(addon, install) {
        do_throw("Should not have seen an available update");
      },

      onUpdateFinished(addon, error) {
        Assert.equal(error, AddonManager.UPDATE_STATUS_DOWNLOAD_ERROR);
        Assert.ok(gSeenExpectedURL);
        executeSoon(shutdownTest);
      }
    }, AddonManager.UPDATE_WHEN_USER_REQUESTED);
  });
}
