// |reftest| skip -- BigInt is not supported
// Copyright (C) 2016 the V8 project authors. All rights reserved.
// This code is governed by the BSD license found in the LICENSE file.
/*---
esid: sec-%typedarray%.prototype.reduceright
description: >
  Returns last accumulator value
info: |
  22.2.3.21 %TypedArray%.prototype.reduceRight ( callbackfn [ , initialValue ] )

  %TypedArray%.prototype.reduceRight is a distinct function that implements the
  same algorithm as Array.prototype.reduceRight as defined in 22.1.3.20 except
  that the this object's [[ArrayLength]] internal slot is accessed in place of
  performing a [[Get]] of "length".

  22.1.3.20 Array.prototype.reduceRight ( callbackfn [ , initialValue ] )

  ...
  7. Else initialValue is not present,
    ...
    b. Repeat, while kPresent is false and k ≥ 0
      ...
      ii. Let kPresent be ? HasProperty(O, Pk).
      iii. If kPresent is true, then
        1. Let accumulator be ? Get(O, Pk).
      iv. Decrease k by 1.
    ...
  8. Repeat, while k ≥ 0
    ...
    c. If kPresent is true, then
      i. Let kValue be ? Get(O, Pk).
      ii. Let accumulator be ? Call(callbackfn, undefined, « accumulator,
      kValue, k, O »).
    d. Decrease k by 1.
  9. Return accumulator.
includes: [testBigIntTypedArray.js]
features: [BigInt, TypedArray]
---*/

testWithBigIntTypedArrayConstructors(function(TA) {
  var calls, result;

  calls = 0;
  result = new TA([1n, 2n, 3n]).reduceRight(function() {
    calls++;

    if (calls == 2) {
      return 42;
    }
  });
  assert.sameValue(result, 42, "using default accumulator");

  calls = 0;
  result = new TA([1n, 2n, 3n]).reduceRight(function() {
    calls++;

    if (calls == 3) {
      return 7;
    }
  }, 0);
  assert.sameValue(result, 7, "using custom accumulator");
});

reportCompare(0, 0);
