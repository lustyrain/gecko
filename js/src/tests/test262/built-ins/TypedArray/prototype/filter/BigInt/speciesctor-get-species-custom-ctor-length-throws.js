// |reftest| skip -- BigInt is not supported
// Copyright (C) 2016 the V8 project authors. All rights reserved.
// This code is governed by the BSD license found in the LICENSE file.
/*---
esid: sec-%typedarray%.prototype.filter
description: >
  Throws a TypeError if new typedArray's length < captured
info: |
  22.2.3.9 %TypedArray%.prototype.filter ( callbackfn [ , thisArg ] )

  ...
  10. Let A be ? TypedArraySpeciesCreate(O, « captured »).
  ...

  22.2.4.7 TypedArraySpeciesCreate ( exemplar, argumentList )

  ...
  4. Return ? TypedArrayCreate(constructor, argumentList).

  22.2.4.6 TypedArrayCreate ( constructor, argumentList )

  ...
  3. If argumentList is a List of a single Number, then
    a. If the value of newTypedArray's [[ArrayLength]] internal slot <
    argumentList[0], throw a TypeError exception.
  ...
includes: [testBigIntTypedArray.js]
features: [BigInt, Symbol.species, TypedArray]
---*/

testWithBigIntTypedArrayConstructors(function(TA) {
  var sample = new TA(2);

  sample.constructor = {};
  sample.constructor[Symbol.species] = function() {
    return new TA();
  };

  assert.throws(TypeError, function() {
    sample.filter(function() { return true; });
  });
});

reportCompare(0, 0);
