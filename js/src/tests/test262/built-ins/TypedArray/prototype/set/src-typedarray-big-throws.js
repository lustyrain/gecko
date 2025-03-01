// |reftest| skip -- BigInt is not supported
// Copyright (C) 2018 Valerie Young. All rights reserved.
// This code is governed by the BSD license found in the LICENSE file.
/*---
esid: sec-%typedarray%.prototype.set-typedarray-offset
description: >
  If typedArray set argument is a Big(U)Int, and target not "Big", throw
info: |
  %TypedArray%.prototype.set( typedArray [ , offset ] )
  Sets multiple values in this TypedArray, reading the values from the
  typedArray argument object. The optional offset value indicates the first
  element index in this TypedArray where values are written. If omitted, it
  is assumed to be 0.
  ...
  23. If one of srcType and targetType contains the substring "Big" and the
      other does not, throw a TypeError exception.
  ...

includes: [testBigIntTypedArray.js, testTypedArray.js]
features: [BigInt, TypedArray]
---*/

var bigTypedArray;
var littleTypedArray;

testWithBigIntTypedArrayConstructors(function(BTA) {

  bigTypedArray = new BTA([1n]);

  testWithTypedArrayConstructors(function(TA) {

    littleTypedArray = new TA(1);
    assert.throws(TypeError, function() {
      littleTypedArray.set(bigTypedArray);
    });
  });

});

reportCompare(0, 0);
