/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ts=8 sts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* base class for representation of media lists */

#ifndef mozilla_dom_MediaList_h
#define mozilla_dom_MediaList_h

#include "mozilla/dom/BindingDeclarations.h"
#include "mozilla/ErrorResult.h"
#include "mozilla/ServoUtils.h"

#include "nsWrapperCache.h"

class nsIDocument;
class nsPresContext;
class nsMediaQueryResultCacheKey;

namespace mozilla {
class StyleSheet;

namespace dom {

// XXX This class doesn't use the branch dispatch approach that we use
//     elsewhere for stylo, but instead just relies on virtual call.
//     That's because this class should not be critical to performance,
//     and using branch dispatch would make it much more complicated.
//     Performance critical path should hold a subclass of this class
//     directly. We may want to determine in the future whether the
//     above is correct.

class MediaList : public nsISupports
                , public nsWrapperCache
{
public:
  NS_DECL_CYCLE_COLLECTING_ISUPPORTS
  NS_DECL_CYCLE_COLLECTION_SCRIPT_HOLDER_CLASS(MediaList)

  static already_AddRefed<MediaList> Create(const nsAString& aMedia,
                                            CallerType aCallerType =
                                              CallerType::NonSystem);

  virtual already_AddRefed<MediaList> Clone() = 0;

  JSObject* WrapObject(JSContext* aCx, JS::Handle<JSObject*> aGivenProto) final;
  nsISupports* GetParentObject() const { return nullptr; }

  virtual void GetText(nsAString& aMediaText) = 0;
  virtual void SetText(const nsAString& aMediaText) = 0;
  virtual bool Matches(nsPresContext* aPresContext) const = 0;

  void SetStyleSheet(StyleSheet* aSheet);

  // WebIDL
  void GetMediaText(nsAString& aMediaText);
  void SetMediaText(const nsAString& aMediaText);
  virtual uint32_t Length() = 0;
  virtual void IndexedGetter(uint32_t aIndex, bool& aFound,
                             nsAString& aReturn) = 0;
  void Item(uint32_t aIndex, nsAString& aResult);
  void DeleteMedium(const nsAString& aMedium, ErrorResult& aRv);
  void AppendMedium(const nsAString& aMedium, ErrorResult& aRv);

protected:
  virtual nsresult Delete(const nsAString& aOldMedium) = 0;
  virtual nsresult Append(const nsAString& aNewMedium) = 0;

  virtual ~MediaList() {
    MOZ_ASSERT(!mStyleSheet, "Backpointer should have been cleared");
  }

  // not refcounted; sheet will let us know when it goes away
  // mStyleSheet is the sheet that needs to be dirtied when this
  // medialist changes
  StyleSheet* mStyleSheet = nullptr;

private:
  template<typename Func>
  inline nsresult DoMediaChange(Func aCallback);
};

} // namespace dom
} // namespace mozilla

#endif // mozilla_dom_MediaList_h
