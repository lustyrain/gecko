// |reftest| skip -- BigInt is not supported
// Copyright (C) 2016 the V8 project authors. All rights reserved.
// This code is governed by the BSD license found in the LICENSE file.
/*---
esid: sec-integer-indexed-exotic-objects-getproperty-p
description: >
  Does not throw on an instance with a detached buffer if key is not a
  CanonicalNumericIndexString
info: |
  9.4.5.2 [[HasProperty]](P)

  ...
  3. If Type(P) is String, then
    a. Let numericIndex be ! CanonicalNumericIndexString(P).
    b. If numericIndex is not undefined, then
    ...
  4. Return ? OrdinaryHasProperty(O, P).
includes: [testBigIntTypedArray.js, detachArrayBuffer.js]
features: [BigInt, Reflect, TypedArray]
---*/

testWithBigIntTypedArrayConstructors(function(TA) {
  var sample = new TA([42n, 43n]);
  Object.defineProperty(sample, "bar", { value: 42 });

  $DETACHBUFFER(sample.buffer);

  assert.sameValue(Reflect.has(sample, "foo"), false);
  assert.sameValue(Reflect.has(sample, "bar"), true);
});

reportCompare(0, 0);
