// |reftest| skip -- BigInt is not supported
// Copyright (C) 2018 Valerie Young. All rights reserved.
// This code is governed by the BSD license found in the LICENSE file.
/*---
esid: sec-typedarray-object
description: >
  Behavior for input array of BigInts
info: |
  TypedArray ( object )
  This description applies only if the TypedArray function is called with at
  least one argument and the Type of the first argument is Object and that
  object does not have either a [[TypedArrayName]] or an [[ArrayBufferData]]
  internal slot.
  ...
  8. Repeat, while k < len
    ...
    b. Let kValue be ? Get(arrayLike, Pk).
    c. Perform ? Set(O, Pk, kValue, true).
  ...

  [[Set]] ( P, V, Receiver)
  ...
  2. If Type(P) is String and if SameValue(O, Receiver) is true, then
    a. Let numericIndex be ! CanonicalNumericIndexString(P).
    b. If numericIndex is not undefined, then
      i. Return ? IntegerIndexedElementSet(O, numericIndex, V).
  ...

  IntegerIndexedElementSet ( O, index, value )
  ...
  5. If arrayTypeName is "BigUint64Array" or "BigInt64Array",
     let numValue be ? ToBigInt(value).
  ...
  15. Perform SetValueInBuffer(buffer, indexedPosition, elementType, numValue, true, "Unordered").
      // NOTE: type will be set to BigInt64 in this test
  16. Return true.

  SetValueInBuffer ( arrayBuffer, byteIndex, type, value, isTypedArray, order [ , isLittleEndian ] )
  ...
  8. Let rawBytes be NumberToRawBytes(type, value, isLittleEndian).
  ...

  NumberToRawBytes( type, value, isLittleEndian )
  ...
  3. Else,
    a. Let n be the Number value of the Element Size specified in Table
       [The TypedArray Constructors] for Element Type type.
    b. Let convOp be the abstract operation named in the Conversion Operation
       column in Table 9 for Element Type type.

  The TypedArray Constructors
  Element Type: BigInt64
  Conversion Operation: ToBigInt64

  ToBigInt64 ( argument )
  The abstract operation ToBigInt64 converts argument to one of 264 integer
  values in the range -2^63 through 2^63-1, inclusive.
  This abstract operation functions as follows:
    1. Let n be ? ToBigInt(argument).
    2. Let int64bit be n modulo 2^64.
    3. If int64bit ≥ 2^63, return int64bit - 2^64; otherwise return int64bit.

includes: [testBigIntTypedArray.js]
features: [BigInt, TypedArray]
---*/

var vals = [
  18446744073709551618n, // 2n ** 64n + 2n
  9223372036854775810n, // 2n ** 63n + 2n
  2n,
  0n,
  -2n,
  -9223372036854775810n, // -(2n ** 63n) - 2n
  -18446744073709551618n, // -(2n ** 64n) - 2n
];

var typedArray = new BigInt64Array(vals);

assert.sameValue(typedArray[0], 2n,
                 "ToBigInt64(2n ** 64n + 2n) => 2n");

assert.sameValue(typedArray[1], -9223372036854775806n, // 2n - 2n ** 63n
                 "ToBigInt64(2n ** 63n + 2n) => -9223372036854775806n");

assert.sameValue(typedArray[2], 2n,
                 "ToBigInt64(2n) => 2n");

assert.sameValue(typedArray[3], 0n,
                 "ToBigInt64(0n) => 0n");

assert.sameValue(typedArray[4], -2n,
                 "ToBigInt64( -2n) => -2n");

assert.sameValue(typedArray[5], 9223372036854775806n, // 2n ** 63n - 2
                 "ToBigInt64( -(2n ** 64n) - 2n) => 9223372036854775806n");

assert.sameValue(typedArray[6], -2n,
                 "ToBigInt64( -(2n ** 64n) - 2n) => -2n");


reportCompare(0, 0);
