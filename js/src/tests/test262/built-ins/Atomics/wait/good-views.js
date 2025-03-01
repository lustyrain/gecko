// |reftest| skip-if(!this.hasOwnProperty('Atomics')) -- Atomics is not enabled unconditionally
// Copyright (C) 2017 Mozilla Corporation.  All rights reserved.
// This code is governed by the BSD license found in the LICENSE file.

/*---
esid: sec-atomics.wait
description: >
  Test Atomics.wait on arrays that allow atomic operations,
  in an Agent that is allowed to wait.
features: [Atomics]
---*/

// Let's assume 'wait' is not allowed on the main thread,
// even in the shell.

$262.agent.start(
`
var sab = new SharedArrayBuffer(1024);
var ab = new ArrayBuffer(16);

var good_indices = [ (view) => 0/-1, // -0
                     (view) => '-0',
                     (view) => view.length - 1,
                     (view) => ({ valueOf: () => 0 }),
                     (view) => ({ toString: () => '0', valueOf: false }) // non-callable valueOf triggers invocation of toString
                   ];

var view = new Int32Array(sab, 32, 20);

view[0] = 0;
$262.agent.report("A " + Atomics.wait(view, 0, 0, 0))
$262.agent.report("B " + Atomics.wait(view, 0, 37, 0));

// In-bounds boundary cases for indexing
for ( let IdxGen of good_indices ) {
    let Idx = IdxGen(view);
    view.fill(0);
    // Atomics.store() computes an index from Idx in the same way as other
    // Atomics operations, not quite like view[Idx].
    Atomics.store(view, Idx, 37);
    $262.agent.report("C " + Atomics.wait(view, Idx, 0));
}

$262.agent.report("done");
$262.agent.leaving();
`)

assert.sameValue(getReport(), "A timed-out");
assert.sameValue(getReport(), "B not-equal"); // Even with zero timeout
var r;
while ((r = getReport()) != "done")
  assert.sameValue(r, "C not-equal");

function getReport() {
  var r;
  while ((r = $262.agent.getReport()) == null)
    $262.agent.sleep(100);
  return r;
}

reportCompare(0, 0);
