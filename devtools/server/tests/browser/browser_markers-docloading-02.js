/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Test that we get DOMContentLoaded and Load markers
 */
"use strict";

const { TimelineFront } = require("devtools/shared/fronts/timeline");
const MARKER_NAMES = ["document::DOMContentLoaded", "document::Load"];

add_task(async function() {
  let browser = await addTab(MAIN_DOMAIN + "doc_innerHTML.html");

  initDebuggerServer();
  let client = new DebuggerClient(DebuggerServer.connectPipe());
  let form = await connectDebuggerClient(client);
  let front = TimelineFront(client, form);
  let rec = await front.start({ withMarkers: true, withDocLoadingEvents: true });

  await new Promise(resolve => {
    front.once("doc-loading", resolve);
    ContentTask.spawn(browser, null, function() {
      content.location.reload();
    });
  });

  ok(true, "At least one doc-loading event got fired.");

  await waitForMarkerType(front, MARKER_NAMES, () => true, e => e, "markers");
  await front.stop(rec);

  ok(true, "Found the required marker names.");

  await client.close();
  gBrowser.removeCurrentTab();
});
