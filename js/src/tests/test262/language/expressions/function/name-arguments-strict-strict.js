// |reftest| error:SyntaxError
'use strict';
// Copyright (c) 2012 Ecma International.  All rights reserved.
// This code is governed by the BSD license found in the LICENSE file.

/*---
es5id: 13.1-14-s
description: >
    StrictMode - SyntaxError is thrown if 'arguments' occurs as the
    Identifier of a FunctionExpression in strict mode
negative:
  phase: parse
  type: SyntaxError
flags: [onlyStrict]
---*/

throw "Test262: This statement should not be evaluated.";

(function arguments() {});
