/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/**
 * Tests if Open in new tab works.
 */

add_task(async function() {
  let { tab, monitor } = await initNetMonitor(CUSTOM_GET_URL);
  info("Starting test...");

  let { document, store, windowRequire } = monitor.panelWin;
  let contextMenuDoc = monitor.panelWin.parent.document;
  let Actions = windowRequire("devtools/client/netmonitor/src/actions/index");

  store.dispatch(Actions.batchEnable(false));

  // Execute requests.
  await performRequests(monitor, tab, 1);

  wait = waitForDOM(contextMenuDoc, "#request-list-context-newtab");
  EventUtils.sendMouseEvent({ type: "mousedown" },
    document.querySelectorAll(".request-list-item")[0]);
  EventUtils.sendMouseEvent({ type: "contextmenu" },
    document.querySelectorAll(".request-list-item")[0]);
  await wait;

  let onTabOpen = once(gBrowser.tabContainer, "TabOpen", false);
  monitor.panelWin.parent.document
    .querySelector("#request-list-context-newtab").click();
  await onTabOpen;

  ok(true, "A new tab has been opened");

  await teardown(monitor);

  gBrowser.removeCurrentTab();
});
