// |reftest| skip -- BigInt is not supported
// Copyright (C) 2016 the V8 project authors. All rights reserved.
// This code is governed by the BSD license found in the LICENSE file.
/*---
esid: sec-typedarray-typedarray
description: >
  Return abrupt completion from getting typedArray argument's buffer.constructor
info: |
  22.2.4.3 TypedArray ( typedArray )

  This description applies only if the TypedArray function is called with at
  least one argument and the Type of the first argument is Object and that
  object has a [[TypedArrayName]] internal slot.

  ...
  18. Else,
    a. Let bufferConstructor be ? SpeciesConstructor(srcData, %ArrayBuffer%).
  ...

  7.3.20 SpeciesConstructor ( O, defaultConstructor )

  ...
  2. Let C be ? Get(O, "constructor").
  ...
includes: [testBigIntTypedArray.js]
features: [BigInt, TypedArray]
---*/

testWithBigIntTypedArrayConstructors(function(TA) {
  var OtherCtor = TA === BigInt64Array ? BigUint64Array : BigInt64Array;
  var sample = new OtherCtor();

  Object.defineProperty(sample.buffer, "constructor", {
    get() {
      throw new Test262Error();
    }
  });

  assert.throws(Test262Error, function() {
    new TA(sample);
  });
});

reportCompare(0, 0);
