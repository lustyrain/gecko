/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ts=8 sts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#ifndef nsAnimationManager_h_
#define nsAnimationManager_h_

#include "mozilla/Attributes.h"
#include "mozilla/ContentEvents.h"
#include "mozilla/EventForwards.h"
#include "AnimationCommon.h"
#include "mozilla/dom/Animation.h"
#include "mozilla/Keyframe.h"
#include "mozilla/MemoryReporting.h"
#include "mozilla/TimeStamp.h"
#include "nsISupportsImpl.h"

class nsIGlobalObject;
class ServoComputedData;
struct nsStyleDisplay;

namespace mozilla {
class ComputedStyle;
namespace css {
class Declaration;
} /* namespace css */
namespace dom {
class KeyframeEffectReadOnly;
class Promise;
} /* namespace dom */

class GeckoComputedStyle;
class ComputedStyle;
enum class CSSPseudoElementType : uint8_t;
struct NonOwningAnimationTarget;

namespace dom {

class CSSAnimation final : public Animation
{
public:
 explicit CSSAnimation(nsIGlobalObject* aGlobal,
                       nsAtom* aAnimationName)
    : dom::Animation(aGlobal)
    , mAnimationName(aAnimationName)
    , mIsStylePaused(false)
    , mPauseShouldStick(false)
    , mNeedsNewAnimationIndexWhenRun(false)
    , mPreviousPhase(ComputedTiming::AnimationPhase::Idle)
    , mPreviousIteration(0)
  {
    // We might need to drop this assertion once we add a script-accessible
    // constructor but for animations generated from CSS markup the
    // animation-name should never be empty.
    MOZ_ASSERT(mAnimationName != nsGkAtoms::_empty,
               "animation-name should not be 'none'");
  }

  JSObject* WrapObject(JSContext* aCx,
                       JS::Handle<JSObject*> aGivenProto) override;

  CSSAnimation* AsCSSAnimation() override { return this; }
  const CSSAnimation* AsCSSAnimation() const override { return this; }

  // CSSAnimation interface
  void GetAnimationName(nsString& aRetVal) const
  {
    mAnimationName->ToString(aRetVal);
  }

  nsAtom* AnimationName() const { return mAnimationName; }

  // Animation interface overrides
  virtual Promise* GetReady(ErrorResult& aRv) override;
  virtual void Play(ErrorResult& aRv, LimitBehavior aLimitBehavior) override;
  virtual void Pause(ErrorResult& aRv) override;

  // NOTE: tabbrowser.xml currently relies on the fact that reading the
  // currentTime of a CSSAnimation does *not* flush style (whereas reading the
  // playState does). If CSS Animations 2 specifies that reading currentTime
  // also flushes style we will need to find another way to detect canceled
  // animations in tabbrowser.xml. On the other hand, if CSS Animations 2
  // specifies that reading playState does *not* flush style (and we drop the
  // following override), then we should update tabbrowser.xml to check
  // the playState instead.
  AnimationPlayState PlayStateFromJS() const override;
  bool PendingFromJS() const override;
  void PlayFromJS(ErrorResult& aRv) override;

  void PlayFromStyle();
  void PauseFromStyle();
  void CancelFromStyle() override
  {
    // When an animation is disassociated with style it enters an odd state
    // where its composite order is undefined until it first transitions
    // out of the idle state.
    //
    // Even if the composite order isn't defined we don't want it to be random
    // in case we need to determine the order to dispatch events associated
    // with an animation in this state. To solve this we treat the animation as
    // if it had been added to the end of the global animation list so that
    // its sort order is defined. We'll update this index again once the
    // animation leaves the idle state.
    mAnimationIndex = sNextAnimationIndex++;
    mNeedsNewAnimationIndexWhenRun = true;

    Animation::CancelFromStyle();

    // We need to do this *after* calling CancelFromStyle() since
    // CancelFromStyle might synchronously trigger a cancel event for which
    // we need an owning element to target the event at.
    mOwningElement = OwningElementRef();
  }

  void Tick() override;
  void QueueEvents(const StickyTimeDuration& aActiveTime = StickyTimeDuration());

  bool IsStylePaused() const { return mIsStylePaused; }

  bool HasLowerCompositeOrderThan(const CSSAnimation& aOther) const;

  void SetAnimationIndex(uint64_t aIndex)
  {
    MOZ_ASSERT(IsTiedToMarkup());
    if (IsRelevant() &&
        mAnimationIndex != aIndex) {
      nsNodeUtils::AnimationChanged(this);
      PostUpdate();
    }
    mAnimationIndex = aIndex;
  }

  // Sets the owning element which is used for determining the composite
  // order of CSSAnimation objects generated from CSS markup.
  //
  // @see mOwningElement
  void SetOwningElement(const OwningElementRef& aElement)
  {
    mOwningElement = aElement;
  }
  // True for animations that are generated from CSS markup and continue to
  // reflect changes to that markup.
  bool IsTiedToMarkup() const { return mOwningElement.IsSet(); }

  void MaybeQueueCancelEvent(const StickyTimeDuration& aActiveTime) override {
    QueueEvents(aActiveTime);
  }

protected:
  virtual ~CSSAnimation()
  {
    MOZ_ASSERT(!mOwningElement.IsSet(), "Owning element should be cleared "
                                        "before a CSS animation is destroyed");
  }

  // Animation overrides
  void UpdateTiming(SeekFlag aSeekFlag,
                    SyncNotifyFlag aSyncNotifyFlag) override;

  // Returns the duration from the start of the animation's source effect's
  // active interval to the point where the animation actually begins playback.
  // This is zero unless the animation's source effect has a negative delay in
  // which case it is the absolute value of that delay.
  // This is used for setting the elapsedTime member of CSS AnimationEvents.
  TimeDuration InitialAdvance() const {
    return mEffect ?
           std::max(TimeDuration(), mEffect->SpecifiedTiming().Delay() * -1) :
           TimeDuration();
  }

  RefPtr<nsAtom> mAnimationName;

  // The (pseudo-)element whose computed animation-name refers to this
  // animation (if any).
  //
  // This is used for determining the relative composite order of animations
  // generated from CSS markup.
  //
  // Typically this will be the same as the target element of the keyframe
  // effect associated with this animation. However, it can differ in the
  // following circumstances:
  //
  // a) If script removes or replaces the effect of this animation,
  // b) If this animation is cancelled (e.g. by updating the
  //    animation-name property or removing the owning element from the
  //    document),
  // c) If this object is generated from script using the CSSAnimation
  //    constructor.
  //
  // For (b) and (c) the owning element will return !IsSet().
  OwningElementRef mOwningElement;

  // When combining animation-play-state with play() / pause() the following
  // behavior applies:
  // 1. pause() is sticky and always overrides the underlying
  //    animation-play-state
  // 2. If animation-play-state is 'paused', play() will temporarily override
  //    it until animation-play-state next becomes 'running'.
  // 3. Calls to play() trigger finishing behavior but setting the
  //    animation-play-state to 'running' does not.
  //
  // This leads to five distinct states:
  //
  // A. Running
  // B. Running and temporarily overriding animation-play-state: paused
  // C. Paused and sticky overriding animation-play-state: running
  // D. Paused and sticky overriding animation-play-state: paused
  // E. Paused by animation-play-state
  //
  // C and D may seem redundant but they differ in how to respond to the
  // sequence: call play(), set animation-play-state: paused.
  //
  // C will transition to A then E leaving the animation paused.
  // D will transition to B then B leaving the animation running.
  //
  // A state transition chart is as follows:
  //
  //             A | B | C | D | E
  //   ---------------------------
  //   play()    A | B | A | B | B
  //   pause()   C | D | C | D | D
  //   'running' A | A | C | C | A
  //   'paused'  E | B | D | D | E
  //
  // The base class, Animation already provides a boolean value,
  // mIsPaused which gives us two states. To this we add a further two booleans
  // to represent the states as follows.
  //
  // A. Running
  //    (!mIsPaused; !mIsStylePaused; !mPauseShouldStick)
  // B. Running and temporarily overriding animation-play-state: paused
  //    (!mIsPaused; mIsStylePaused; !mPauseShouldStick)
  // C. Paused and sticky overriding animation-play-state: running
  //    (mIsPaused; !mIsStylePaused; mPauseShouldStick)
  // D. Paused and sticky overriding animation-play-state: paused
  //    (mIsPaused; mIsStylePaused; mPauseShouldStick)
  // E. Paused by animation-play-state
  //    (mIsPaused; mIsStylePaused; !mPauseShouldStick)
  //
  // (That leaves 3 combinations of the boolean values that we never set because
  // they don't represent valid states.)
  bool mIsStylePaused;
  bool mPauseShouldStick;

  // When true, indicates that when this animation next leaves the idle state,
  // its animation index should be updated.
  bool mNeedsNewAnimationIndexWhenRun;

  // Phase and current iteration from the previous time we queued events.
  // This is used to determine what new events to dispatch.
  ComputedTiming::AnimationPhase mPreviousPhase;
  uint64_t mPreviousIteration;
};

} /* namespace dom */

template <>
struct AnimationTypeTraits<dom::CSSAnimation>
{
  static nsAtom* ElementPropertyAtom()
  {
    return nsGkAtoms::animationsProperty;
  }
  static nsAtom* BeforePropertyAtom()
  {
    return nsGkAtoms::animationsOfBeforeProperty;
  }
  static nsAtom* AfterPropertyAtom()
  {
    return nsGkAtoms::animationsOfAfterProperty;
  }
};

} /* namespace mozilla */

class nsAnimationManager final
  : public mozilla::CommonAnimationManager<mozilla::dom::CSSAnimation>
{
public:
  explicit nsAnimationManager(nsPresContext *aPresContext)
    : mozilla::CommonAnimationManager<mozilla::dom::CSSAnimation>(aPresContext)
  {
  }

  NS_INLINE_DECL_REFCOUNTING(nsAnimationManager)

  typedef mozilla::AnimationCollection<mozilla::dom::CSSAnimation>
    CSSAnimationCollection;
  typedef nsTArray<RefPtr<mozilla::dom::CSSAnimation>>
    OwningCSSAnimationPtrArray;


  /**
   * This function does the same thing as the above UpdateAnimations()
   * but with servo's computed values.
   */
  void UpdateAnimations(
    mozilla::dom::Element* aElement,
    mozilla::CSSPseudoElementType aPseudoType,
    const mozilla::ComputedStyle* aComputedValues);

  // Utility function to walk through |aIter| to find the Keyframe with
  // matching offset and timing function but stopping as soon as the offset
  // differs from |aOffset| (i.e. it assumes a sorted iterator).
  //
  // If a matching Keyframe is found,
  //   Returns true and sets |aIndex| to the index of the matching Keyframe
  //   within |aIter|.
  //
  // If no matching Keyframe is found,
  //   Returns false and sets |aIndex| to the index in the iterator of the
  //   first Keyframe with an offset differing to |aOffset| or, if the end
  //   of the iterator is reached, sets |aIndex| to the index after the last
  //   Keyframe.
  template <class IterType, class TimingFunctionType>
  static bool FindMatchingKeyframe(
    IterType&& aIter,
    double aOffset,
    const TimingFunctionType& aTimingFunctionToMatch,
    size_t& aIndex)
  {
    aIndex = 0;
    for (mozilla::Keyframe& keyframe : aIter) {
      if (keyframe.mOffset.value() != aOffset) {
        break;
      }
      if (keyframe.mTimingFunction == aTimingFunctionToMatch) {
        return true;
      }
      ++aIndex;
    }
    return false;
  }

  bool AnimationMayBeReferenced(nsAtom* aName) const
  {
    return mMaybeReferencedAnimations.Contains(aName);
  }

protected:
  ~nsAnimationManager() override = default;

private:
  // This includes all animation names referenced regardless of whether a
  // corresponding `@keyframes` rule is available.
  //
  // It may contain names which are no longer referenced, but it should always
  // contain names which are currently referenced, so that it is usable for
  // style invalidation.
  nsTHashtable<nsRefPtrHashKey<nsAtom>> mMaybeReferencedAnimations;

  template<class BuilderType>
  void DoUpdateAnimations(
    const mozilla::NonOwningAnimationTarget& aTarget,
    const nsStyleDisplay& aStyleDisplay,
    BuilderType& aBuilder);
};

#endif /* !defined(nsAnimationManager_h_) */
