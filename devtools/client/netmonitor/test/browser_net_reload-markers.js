/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/**
 * Tests if the empty-requests reload button works.
 */

add_task(async function() {
  let { monitor } = await initNetMonitor(SIMPLE_URL);
  info("Starting test... ");

  let { document } = monitor.panelWin;

  let markersDone = waitForTimelineMarkers(monitor);

  let button = document.querySelector(".requests-list-reload-notice-button");
  button.click();

  await waitForNetworkEvents(monitor, 1);
  let markers = await markersDone;

  ok(true, "Reloading finished");

  is(markers[0].name, "dom-interactive",
    "The first received marker is correct.");
  is(markers[1].name, "dom-complete",
    "The second received marker is correct.");

  return teardown(monitor);
});
