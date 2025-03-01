// Copyright (C) 2015 the V8 project authors. All rights reserved.
// This code is governed by the BSD license found in the LICENSE file.
/*---
es6id: 9.5.7
description: >
    The result of [[HasProperty]] is a Boolean value and will affect has
    checkings. True returned when target property exists;
---*/

var target = {
  attr: 1
};
var p = new Proxy(target, {
  has: function(t, prop) {
    return 1;
  }
});

assert.sameValue(("attr" in p), true);

reportCompare(0, 0);
