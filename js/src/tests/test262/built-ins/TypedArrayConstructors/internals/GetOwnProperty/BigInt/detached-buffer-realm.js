// |reftest| skip -- BigInt is not supported
// Copyright (C) 2016 the V8 project authors. All rights reserved.
// This code is governed by the BSD license found in the LICENSE file.
/*---
esid: sec-integer-indexed-exotic-objects-getownproperty-p
description: >
  Throws a TypeError if this has a detached buffer (honoring the Realm of the
  current execution context)
info: |
  9.4.5.1 [[GetOwnProperty]] ( P )

  ...
  3. If Type(P) is String, then
    a. Let numericIndex be ! CanonicalNumericIndexString(P).
    b. If numericIndex is not undefined, then
      i. Let value be ? IntegerIndexedElementGet(O, numericIndex).
  ...

  9.4.5.8 IntegerIndexedElementGet ( O, index )

  ...
  3. Let buffer be the value of O's [[ViewedArrayBuffer]] internal slot.
  4. If IsDetachedBuffer(buffer) is true, throw a TypeError exception.
  ...
includes: [testBigIntTypedArray.js, detachArrayBuffer.js]
features: [BigInt, cross-realm, TypedArray]
---*/

var other = $262.createRealm().global;

testWithBigIntTypedArrayConstructors(function(TA) {
  var OtherTA = other[TA.name];
  var sample = new OtherTA(1);

  $DETACHBUFFER(sample.buffer);

  assert.throws(TypeError, function() {
    Object.getOwnPropertyDescriptor(sample, 0);
  });
});

reportCompare(0, 0);
