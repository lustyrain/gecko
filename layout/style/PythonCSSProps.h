/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ts=8 sts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* A file meant as input to the preprocessor only */

/* DO_PROP serves as an extra level of indirection to allow expansion
   of CSS_PROP_DOMPROP_PREFIXED */

[

#define PROP_STRINGIFY_INTERNAL(X) #X
#define PROP_STRINGIFY(X) PROP_STRINGIFY_INTERNAL(X)

#define DO_PROP(name, method, id, flags, pref, proptype) \
  [ #name, #method, #id, PROP_STRINGIFY(flags), pref, proptype ],
#define CSS_PROP(name, id, method, flags, pref, ...) \
  DO_PROP(name, method, id, flags, pref, "longhand")
#define CSS_PROP_SHORTHAND(name, id, method, flags, pref) \
  DO_PROP(name, method, id, flags, pref, "shorthand")
#define CSS_PROP_LOGICAL(name, id, method, flags, pref, ...) \
  DO_PROP(name, method, id, flags, pref, "logical")
#define CSS_PROP_PUBLIC_OR_PRIVATE(publicname_, privatename_) publicname_

#include "nsCSSPropList.h"

#undef CSS_PROP_PUBLIC_OR_PRIVATE
#undef CSS_PROP_LOGICAL
#undef CSS_PROP_SHORTHAND
#undef CSS_PROP

#define CSS_PROP_ALIAS(name, aliasid_, id, method, pref) \
  DO_PROP(name, method, id, 0, pref, "alias")

#include "nsCSSPropAliasList.h"

#undef CSS_PROP_ALIAS

#undef DO_PROP
#undef PROP_STRINGIFY
#undef PROP_STRINGIFY_INTERNAL

]
