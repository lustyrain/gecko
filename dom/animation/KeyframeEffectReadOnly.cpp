/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ts=8 sts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/dom/KeyframeEffectReadOnly.h"

#include "FrameLayerBuilder.h"
#include "mozilla/dom/Animation.h"
#include "mozilla/dom/KeyframeAnimationOptionsBinding.h"
  // For UnrestrictedDoubleOrKeyframeAnimationOptions;
#include "mozilla/dom/CSSPseudoElement.h"
#include "mozilla/dom/KeyframeEffectBinding.h"
#include "mozilla/AnimationUtils.h"
#include "mozilla/AutoRestore.h"
#include "mozilla/ComputedStyleInlines.h"
#include "mozilla/EffectSet.h"
#include "mozilla/FloatingPoint.h" // For IsFinite
#include "mozilla/LayerAnimationInfo.h"
#include "mozilla/LookAndFeel.h" // For LookAndFeel::GetInt
#include "mozilla/KeyframeUtils.h"
#include "mozilla/ServoBindings.h"
#include "mozilla/TypeTraits.h"
#include "Layers.h" // For Layer
#include "nsComputedDOMStyle.h" // nsComputedDOMStyle::GetComputedStyle
#include "nsContentUtils.h"
#include "nsCSSPropertyIDSet.h"
#include "nsCSSProps.h" // For nsCSSProps::PropHasFlags
#include "nsCSSPseudoElements.h" // For CSSPseudoElementType
#include "nsDocument.h" // For nsDocument::IsWebAnimationsEnabled
#include "nsIFrame.h"
#include "nsIPresShell.h"
#include "nsIScriptError.h"
#include "nsRefreshDriver.h"

namespace mozilla {

bool
PropertyValuePair::operator==(const PropertyValuePair& aOther) const
{
  if (mProperty != aOther.mProperty) {
    return false;
  }
  if (mServoDeclarationBlock == aOther.mServoDeclarationBlock) {
    return true;
  }
  if (!mServoDeclarationBlock || !aOther.mServoDeclarationBlock) {
    return false;
  }
  return Servo_DeclarationBlock_Equals(mServoDeclarationBlock,
                                       aOther.mServoDeclarationBlock);
}

namespace dom {

NS_IMPL_CYCLE_COLLECTION_INHERITED(KeyframeEffectReadOnly,
                                   AnimationEffectReadOnly,
                                   mTarget)

NS_IMPL_CYCLE_COLLECTION_TRACE_BEGIN_INHERITED(KeyframeEffectReadOnly,
                                               AnimationEffectReadOnly)
NS_IMPL_CYCLE_COLLECTION_TRACE_END

NS_INTERFACE_MAP_BEGIN_CYCLE_COLLECTION(KeyframeEffectReadOnly)
NS_INTERFACE_MAP_END_INHERITING(AnimationEffectReadOnly)

NS_IMPL_ADDREF_INHERITED(KeyframeEffectReadOnly, AnimationEffectReadOnly)
NS_IMPL_RELEASE_INHERITED(KeyframeEffectReadOnly, AnimationEffectReadOnly)

KeyframeEffectReadOnly::KeyframeEffectReadOnly(
  nsIDocument* aDocument,
  const Maybe<OwningAnimationTarget>& aTarget,
  const TimingParams& aTiming,
  const KeyframeEffectParams& aOptions)
  : KeyframeEffectReadOnly(aDocument, aTarget,
                           new AnimationEffectTimingReadOnly(aDocument,
                                                             aTiming),
                           aOptions)
{
}

KeyframeEffectReadOnly::KeyframeEffectReadOnly(
  nsIDocument* aDocument,
  const Maybe<OwningAnimationTarget>& aTarget,
  AnimationEffectTimingReadOnly* aTiming,
  const KeyframeEffectParams& aOptions)
  : AnimationEffectReadOnly(aDocument, aTiming)
  , mTarget(aTarget)
  , mEffectOptions(aOptions)
  , mInEffectOnLastAnimationTimingUpdate(false)
  , mCumulativeChangeHint(nsChangeHint(0))
{
}

JSObject*
KeyframeEffectReadOnly::WrapObject(JSContext* aCx,
                                   JS::Handle<JSObject*> aGivenProto)
{
  return KeyframeEffectReadOnlyBinding::Wrap(aCx, this, aGivenProto);
}

IterationCompositeOperation
KeyframeEffectReadOnly::IterationComposite() const
{
  return mEffectOptions.mIterationComposite;
}

CompositeOperation
KeyframeEffectReadOnly::Composite() const
{
  return mEffectOptions.mComposite;
}

void
KeyframeEffectReadOnly::NotifyAnimationTimingUpdated()
{
  UpdateTargetRegistration();

  // If the effect is not relevant it will be removed from the target
  // element's effect set. However, effects not in the effect set
  // will not be included in the set of candidate effects for running on
  // the compositor and hence they won't have their compositor status
  // updated. As a result, we need to make sure we clear their compositor
  // status here.
  bool isRelevant = mAnimation && mAnimation->IsRelevant();
  if (!isRelevant) {
    ResetIsRunningOnCompositor();
  }

  // Request restyle if necessary.
  if (mAnimation && !mProperties.IsEmpty() && HasComputedTimingChanged()) {
    EffectCompositor::RestyleType restyleType =
      CanThrottle() ?
      EffectCompositor::RestyleType::Throttled :
      EffectCompositor::RestyleType::Standard;
    RequestRestyle(restyleType);
  }

  // Detect changes to "in effect" status since we need to recalculate the
  // animation cascade for this element whenever that changes.
  // Note that updating mInEffectOnLastAnimationTimingUpdate has to be done
  // after above CanThrottle() call since the function uses the flag inside it.
  bool inEffect = IsInEffect();
  if (inEffect != mInEffectOnLastAnimationTimingUpdate) {
    MarkCascadeNeedsUpdate();
    mInEffectOnLastAnimationTimingUpdate = inEffect;
  }

  // If we're no longer "in effect", our ComposeStyle method will never be
  // called and we will never have a chance to update mProgressOnLastCompose
  // and mCurrentIterationOnLastCompose.
  // We clear them here to ensure that if we later become "in effect" we will
  // request a restyle (above).
  if (!inEffect) {
     mProgressOnLastCompose.SetNull();
     mCurrentIterationOnLastCompose = 0;
  }
}

static bool
KeyframesEqualIgnoringComputedOffsets(const nsTArray<Keyframe>& aLhs,
                                      const nsTArray<Keyframe>& aRhs)
{
  if (aLhs.Length() != aRhs.Length()) {
    return false;
  }

  for (size_t i = 0, len = aLhs.Length(); i < len; ++i) {
    const Keyframe& a = aLhs[i];
    const Keyframe& b = aRhs[i];
    if (a.mOffset != b.mOffset ||
        a.mTimingFunction != b.mTimingFunction ||
        a.mPropertyValues != b.mPropertyValues) {
      return false;
    }
  }
  return true;
}

// https://drafts.csswg.org/web-animations/#dom-keyframeeffect-setkeyframes
void
KeyframeEffectReadOnly::SetKeyframes(JSContext* aContext,
                                     JS::Handle<JSObject*> aKeyframes,
                                     ErrorResult& aRv)
{
  nsTArray<Keyframe> keyframes =
    KeyframeUtils::GetKeyframesFromObject(aContext, mDocument, aKeyframes, aRv);
  if (aRv.Failed()) {
    return;
  }

  RefPtr<ComputedStyle> style = GetTargetComputedStyle();
  if (style) {
    SetKeyframes(Move(keyframes), style);
  } else {
    // SetKeyframes has the same behavior for null StyleType* for
    // both backends, just pick one and use it.
    SetKeyframes(Move(keyframes), (ComputedStyle*) nullptr);
  }
}


void
KeyframeEffectReadOnly::SetKeyframes(
  nsTArray<Keyframe>&& aKeyframes,
  const ComputedStyle* aComputedValues)
{
  DoSetKeyframes(Move(aKeyframes), aComputedValues);
}

template<typename StyleType>
void
KeyframeEffectReadOnly::DoSetKeyframes(nsTArray<Keyframe>&& aKeyframes,
                                       StyleType* aStyle)
{

  if (KeyframesEqualIgnoringComputedOffsets(aKeyframes, mKeyframes)) {
    return;
  }

  mKeyframes = Move(aKeyframes);
  KeyframeUtils::DistributeKeyframes(mKeyframes);

  if (mAnimation && mAnimation->IsRelevant()) {
    nsNodeUtils::AnimationChanged(mAnimation);
  }

  // We need to call UpdateProperties() if the StyleType is not nullptr.
  if (aStyle) {
    UpdateProperties(aStyle);
    MaybeUpdateFrameForCompositor();
  }
}

const AnimationProperty*
KeyframeEffectReadOnly::GetEffectiveAnimationOfProperty(
  nsCSSPropertyID aProperty) const
{
  EffectSet* effectSet =
    EffectSet::GetEffectSet(mTarget->mElement, mTarget->mPseudoType);
  for (size_t propIdx = 0, propEnd = mProperties.Length();
       propIdx != propEnd; ++propIdx) {
    if (aProperty == mProperties[propIdx].mProperty) {
      const AnimationProperty* result = &mProperties[propIdx];
      // Skip if there is a property of animation level that is overridden
      // by !important rules.
      if (effectSet &&
          effectSet->PropertiesWithImportantRules()
            .HasProperty(result->mProperty) &&
          effectSet->PropertiesForAnimationsLevel()
            .HasProperty(result->mProperty)) {
        result = nullptr;
      }
      return result;
    }
  }
  return nullptr;
}

bool
KeyframeEffectReadOnly::HasAnimationOfProperty(nsCSSPropertyID aProperty) const
{
  for (const AnimationProperty& property : mProperties) {
    if (property.mProperty == aProperty) {
      return true;
    }
  }
  return false;
}

#ifdef DEBUG
bool
SpecifiedKeyframeArraysAreEqual(const nsTArray<Keyframe>& aA,
                                const nsTArray<Keyframe>& aB)
{
  if (aA.Length() != aB.Length()) {
    return false;
  }

  for (size_t i = 0; i < aA.Length(); i++) {
    const Keyframe& a = aA[i];
    const Keyframe& b = aB[i];
    if (a.mOffset         != b.mOffset ||
        a.mTimingFunction != b.mTimingFunction ||
        a.mPropertyValues != b.mPropertyValues) {
      return false;
    }
  }

  return true;
}
#endif

void
KeyframeEffectReadOnly::UpdateProperties(const ComputedStyle* aComputedStyle)
{
  DoUpdateProperties(aComputedStyle);
}

template<typename StyleType>
void
KeyframeEffectReadOnly::DoUpdateProperties(StyleType* aStyle)
{
  MOZ_ASSERT(aStyle);

  // Skip updating properties when we are composing style.
  // FIXME: Bug 1324966. Drop this check once we have a function to get
  // ComputedStyle without resolving animating style.
  MOZ_DIAGNOSTIC_ASSERT(!mIsComposingStyle,
                        "Should not be called while processing ComposeStyle()");
  if (mIsComposingStyle) {
    return;
  }

  nsTArray<AnimationProperty> properties = BuildProperties(aStyle);

  // We need to update base styles even if any properties are not changed at all
  // since base styles might have been changed due to parent style changes, etc.
  EnsureBaseStyles(aStyle, properties);

  if (mProperties == properties) {
    return;
  }

  // Preserve the state of the mIsRunningOnCompositor flag.
  nsCSSPropertyIDSet runningOnCompositorProperties;

  for (const AnimationProperty& property : mProperties) {
    if (property.mIsRunningOnCompositor) {
      runningOnCompositorProperties.AddProperty(property.mProperty);
    }
  }

  mProperties = Move(properties);
  UpdateEffectSet();

  for (AnimationProperty& property : mProperties) {
    property.mIsRunningOnCompositor =
      runningOnCompositorProperties.HasProperty(property.mProperty);
  }

  CalculateCumulativeChangeHint(aStyle);

  MarkCascadeNeedsUpdate();

  RequestRestyle(EffectCompositor::RestyleType::Layer);
}


void
KeyframeEffectReadOnly::EnsureBaseStyles(
  const ComputedStyle* aComputedValues,
  const nsTArray<AnimationProperty>& aProperties)
{
  if (!mTarget) {
    return;
  }

  mBaseStyleValuesForServo.Clear();

  nsPresContext* presContext =
    nsContentUtils::GetContextForContent(mTarget->mElement);
  // If |aProperties| is empty we're not going to dereference |presContext| so
  // we don't care if it is nullptr.
  //
  // We could just return early when |aProperties| is empty and save looking up
  // the pres context, but that won't save any effort normally since we don't
  // call this function if we have no keyframes to begin with. Furthermore, the
  // case where |presContext| is nullptr is so rare (we've only ever seen in
  // fuzzing, and even then we've never been able to reproduce it reliably)
  // it's not worth the runtime cost of an extra branch.
  MOZ_ASSERT(presContext || aProperties.IsEmpty(),
             "Typically presContext should not be nullptr but if it is"
             " we should have also failed to calculate the computed values"
             " passed-in as aProperties");

  RefPtr<ComputedStyle> baseComputedStyle;
  for (const AnimationProperty& property : aProperties) {
    EnsureBaseStyle(property,
                    presContext,
                    aComputedValues,
                    baseComputedStyle);
  }
}

void
KeyframeEffectReadOnly::EnsureBaseStyle(
  const AnimationProperty& aProperty,
  nsPresContext* aPresContext,
  const ComputedStyle* aComputedStyle,
 RefPtr<ComputedStyle>& aBaseComputedStyle)
{
  bool hasAdditiveValues = false;

  for (const AnimationPropertySegment& segment : aProperty.mSegments) {
    if (!segment.HasReplaceableValues()) {
      hasAdditiveValues = true;
      break;
    }
  }

  if (!hasAdditiveValues) {
    return;
  }

  if (!aBaseComputedStyle) {
    Element* animatingElement =
      EffectCompositor::GetElementToRestyle(mTarget->mElement,
                                            mTarget->mPseudoType);
    aBaseComputedStyle = aPresContext->StyleSet()->
      GetBaseContextForElement(animatingElement, aComputedStyle);
  }
  RefPtr<RawServoAnimationValue> baseValue =
    Servo_ComputedValues_ExtractAnimationValue(aBaseComputedStyle,
                                               aProperty.mProperty).Consume();
  mBaseStyleValuesForServo.Put(aProperty.mProperty, baseValue);
}

void
KeyframeEffectReadOnly::WillComposeStyle()
{
  ComputedTiming computedTiming = GetComputedTiming();
  mProgressOnLastCompose = computedTiming.mProgress;
  mCurrentIterationOnLastCompose = computedTiming.mCurrentIteration;
}


void
KeyframeEffectReadOnly::ComposeStyleRule(
  RawServoAnimationValueMap& aAnimationValues,
  const AnimationProperty& aProperty,
  const AnimationPropertySegment& aSegment,
  const ComputedTiming& aComputedTiming)
{
  Servo_AnimationCompose(&aAnimationValues,
                         &mBaseStyleValuesForServo,
                         aProperty.mProperty,
                         &aSegment,
                         &aProperty.mSegments.LastElement(),
                         &aComputedTiming,
                         mEffectOptions.mIterationComposite);
}

template<typename ComposeAnimationResult>
void
KeyframeEffectReadOnly::ComposeStyle(
  ComposeAnimationResult&& aComposeResult,
  const nsCSSPropertyIDSet& aPropertiesToSkip)
{
  MOZ_DIAGNOSTIC_ASSERT(!mIsComposingStyle,
                        "Should not be called recursively");
  if (mIsComposingStyle) {
    return;
  }

  AutoRestore<bool> isComposingStyle(mIsComposingStyle);
  mIsComposingStyle = true;

  ComputedTiming computedTiming = GetComputedTiming();

  // If the progress is null, we don't have fill data for the current
  // time so we shouldn't animate.
  if (computedTiming.mProgress.IsNull()) {
    return;
  }

  for (size_t propIdx = 0, propEnd = mProperties.Length();
       propIdx != propEnd; ++propIdx)
  {
    const AnimationProperty& prop = mProperties[propIdx];

    MOZ_ASSERT(prop.mSegments[0].mFromKey == 0.0, "incorrect first from key");
    MOZ_ASSERT(prop.mSegments[prop.mSegments.Length() - 1].mToKey == 1.0,
               "incorrect last to key");

    if (aPropertiesToSkip.HasProperty(prop.mProperty)) {
      continue;
    }

    MOZ_ASSERT(prop.mSegments.Length() > 0,
               "property should not be in animations if it has no segments");

    // FIXME: Maybe cache the current segment?
    const AnimationPropertySegment *segment = prop.mSegments.Elements(),
                                *segmentEnd = segment + prop.mSegments.Length();
    while (segment->mToKey <= computedTiming.mProgress.Value()) {
      MOZ_ASSERT(segment->mFromKey <= segment->mToKey, "incorrect keys");
      if ((segment+1) == segmentEnd) {
        break;
      }
      ++segment;
      MOZ_ASSERT(segment->mFromKey == (segment-1)->mToKey, "incorrect keys");
    }
    MOZ_ASSERT(segment->mFromKey <= segment->mToKey, "incorrect keys");
    MOZ_ASSERT(segment >= prop.mSegments.Elements() &&
               size_t(segment - prop.mSegments.Elements()) <
                 prop.mSegments.Length(),
               "out of array bounds");

    ComposeStyleRule(Forward<ComposeAnimationResult>(aComposeResult),
                     prop,
                     *segment,
                     computedTiming);
  }

  // If the animation produces a transform change hint that affects the overflow
  // region, we need to record the current time to unthrottle the animation
  // periodically when the animation is being throttled because it's scrolled
  // out of view.
  if (HasTransformThatMightAffectOverflow()) {
    nsPresContext* presContext =
      nsContentUtils::GetContextForContent(mTarget->mElement);
    if (presContext) {
      TimeStamp now = presContext->RefreshDriver()->MostRecentRefresh();
      EffectSet* effectSet =
        EffectSet::GetEffectSet(mTarget->mElement, mTarget->mPseudoType);
      MOZ_ASSERT(effectSet, "ComposeStyle should only be called on an effect "
                            "that is part of an effect set");
      effectSet->UpdateLastTransformSyncTime(now);
    }
  }
}

bool
KeyframeEffectReadOnly::IsRunningOnCompositor() const
{
  // We consider animation is running on compositor if there is at least
  // one property running on compositor.
  // Animation.IsRunningOnCompotitor will return more fine grained
  // information in bug 1196114.
  for (const AnimationProperty& property : mProperties) {
    if (property.mIsRunningOnCompositor) {
      return true;
    }
  }
  return false;
}

void
KeyframeEffectReadOnly::SetIsRunningOnCompositor(nsCSSPropertyID aProperty,
                                                 bool aIsRunning)
{
  MOZ_ASSERT(nsCSSProps::PropHasFlags(aProperty,
                                      CSS_PROPERTY_CAN_ANIMATE_ON_COMPOSITOR),
             "Property being animated on compositor is a recognized "
             "compositor-animatable property");
  for (AnimationProperty& property : mProperties) {
    if (property.mProperty == aProperty) {
      property.mIsRunningOnCompositor = aIsRunning;
      // We currently only set a performance warning message when animations
      // cannot be run on the compositor, so if this animation is running
      // on the compositor we don't need a message.
      if (aIsRunning) {
        property.mPerformanceWarning.reset();
      }
      return;
    }
  }
}

void
KeyframeEffectReadOnly::ResetIsRunningOnCompositor()
{
  for (AnimationProperty& property : mProperties) {
    property.mIsRunningOnCompositor = false;
  }
}

static const KeyframeEffectOptions&
KeyframeEffectOptionsFromUnion(
  const UnrestrictedDoubleOrKeyframeEffectOptions& aOptions)
{
  MOZ_ASSERT(aOptions.IsKeyframeEffectOptions());
  return aOptions.GetAsKeyframeEffectOptions();
}

static const KeyframeEffectOptions&
KeyframeEffectOptionsFromUnion(
  const UnrestrictedDoubleOrKeyframeAnimationOptions& aOptions)
{
  MOZ_ASSERT(aOptions.IsKeyframeAnimationOptions());
  return aOptions.GetAsKeyframeAnimationOptions();
}

template <class OptionsType>
static KeyframeEffectParams
KeyframeEffectParamsFromUnion(const OptionsType& aOptions,
                              CallerType aCallerType)
{
  KeyframeEffectParams result;
  if (aOptions.IsUnrestrictedDouble() ||
      // Ignore iterationComposite if the Web Animations API is not enabled,
      // then the default value 'Replace' will be used.
      !nsDocument::IsWebAnimationsEnabled(aCallerType)) {
    return result;
  }

  const KeyframeEffectOptions& options =
    KeyframeEffectOptionsFromUnion(aOptions);
  result.mIterationComposite = options.mIterationComposite;
  result.mComposite = options.mComposite;
  return result;
}

/* static */ Maybe<OwningAnimationTarget>
KeyframeEffectReadOnly::ConvertTarget(
  const Nullable<ElementOrCSSPseudoElement>& aTarget)
{
  // Return value optimization.
  Maybe<OwningAnimationTarget> result;

  if (aTarget.IsNull()) {
    return result;
  }

  const ElementOrCSSPseudoElement& target = aTarget.Value();
  MOZ_ASSERT(target.IsElement() || target.IsCSSPseudoElement(),
             "Uninitialized target");

  if (target.IsElement()) {
    result.emplace(&target.GetAsElement());
  } else {
    RefPtr<Element> elem = target.GetAsCSSPseudoElement().ParentElement();
    result.emplace(elem, target.GetAsCSSPseudoElement().GetType());
  }
  return result;
}

template <class KeyframeEffectType, class OptionsType>
/* static */ already_AddRefed<KeyframeEffectType>
KeyframeEffectReadOnly::ConstructKeyframeEffect(
    const GlobalObject& aGlobal,
    const Nullable<ElementOrCSSPseudoElement>& aTarget,
    JS::Handle<JSObject*> aKeyframes,
    const OptionsType& aOptions,
    ErrorResult& aRv)
{
  // We should get the document from `aGlobal` instead of the current Realm
  // to make this works in Xray case.
  //
  // In all non-Xray cases, `aGlobal` matches the current Realm, so this
  // matches the spec behavior.
  //
  // In Xray case, the new objects should be created using the document of
  // the target global, but KeyframeEffect and KeyframeEffectReadOnly
  // constructors are called in the caller's compartment to access
  // `aKeyframes` object.
  nsIDocument* doc = AnimationUtils::GetDocumentFromGlobal(aGlobal.Get());
  if (!doc) {
    aRv.Throw(NS_ERROR_FAILURE);
    return nullptr;
  }

  TimingParams timingParams =
    TimingParams::FromOptionsUnion(aOptions, doc, aRv);
  if (aRv.Failed()) {
    return nullptr;
  }

  KeyframeEffectParams effectOptions =
    KeyframeEffectParamsFromUnion(aOptions, aGlobal.CallerType());

  Maybe<OwningAnimationTarget> target = ConvertTarget(aTarget);
  RefPtr<KeyframeEffectType> effect =
    new KeyframeEffectType(doc, target, timingParams, effectOptions);

  effect->SetKeyframes(aGlobal.Context(), aKeyframes, aRv);
  if (aRv.Failed()) {
    return nullptr;
  }

  return effect.forget();
}

template<class KeyframeEffectType>
/* static */ already_AddRefed<KeyframeEffectType>
KeyframeEffectReadOnly::ConstructKeyframeEffect(const GlobalObject& aGlobal,
                                                KeyframeEffectReadOnly& aSource,
                                                ErrorResult& aRv)
{
  nsIDocument* doc = AnimationUtils::GetCurrentRealmDocument(aGlobal.Context());
  if (!doc) {
    aRv.Throw(NS_ERROR_FAILURE);
    return nullptr;
  }

  // Create a new KeyframeEffectReadOnly object with aSource's target,
  // iteration composite operation, composite operation, and spacing mode.
  // The constructor creates a new AnimationEffect(ReadOnly) object by
  // aSource's TimingParams.
  // Note: we don't need to re-throw exceptions since the value specified on
  //       aSource's timing object can be assumed valid.
  RefPtr<KeyframeEffectType> effect =
    new KeyframeEffectType(doc,
                           aSource.mTarget,
                           aSource.SpecifiedTiming(),
                           aSource.mEffectOptions);
  // Copy cumulative change hint. mCumulativeChangeHint should be the same as
  // the source one because both of targets are the same.
  effect->mCumulativeChangeHint = aSource.mCumulativeChangeHint;

  // Copy aSource's keyframes and animation properties.
  // Note: We don't call SetKeyframes directly, which might revise the
  //       computed offsets and rebuild the animation properties.
  effect->mKeyframes = aSource.mKeyframes;
  effect->mProperties = aSource.mProperties;
  return effect.forget();
}

template<typename StyleType>
nsTArray<AnimationProperty>
KeyframeEffectReadOnly::BuildProperties(StyleType* aStyle)
{

  MOZ_ASSERT(aStyle);

  nsTArray<AnimationProperty> result;
  // If mTarget is null, return an empty property array.
  if (!mTarget) {
    return result;
  }

  // When GetComputedKeyframeValues or GetAnimationPropertiesFromKeyframes
  // calculate computed values from |mKeyframes|, they could possibly
  // trigger a subsequent restyle in which we rebuild animations. If that
  // happens we could find that |mKeyframes| is overwritten while it is
  // being iterated over. Normally that shouldn't happen but just in case we
  // make a copy of |mKeyframes| first and iterate over that instead.
  auto keyframesCopy(mKeyframes);

  result =
    KeyframeUtils::GetAnimationPropertiesFromKeyframes(
      keyframesCopy,
      mTarget->mElement,
      aStyle,
      mEffectOptions.mComposite);

#ifdef DEBUG
  MOZ_ASSERT(SpecifiedKeyframeArraysAreEqual(mKeyframes, keyframesCopy),
             "Apart from the computed offset members, the keyframes array"
             " should not be modified");
#endif

  mKeyframes.SwapElements(keyframesCopy);
  return result;
}

void
KeyframeEffectReadOnly::UpdateTargetRegistration()
{
  if (!mTarget) {
    return;
  }

  bool isRelevant = mAnimation && mAnimation->IsRelevant();

  // Animation::IsRelevant() returns a cached value. It only updates when
  // something calls Animation::UpdateRelevance. Whenever our timing changes,
  // we should be notifying our Animation before calling this, so
  // Animation::IsRelevant() should be up-to-date by the time we get here.
  MOZ_ASSERT(isRelevant == IsCurrent() || IsInEffect(),
             "Out of date Animation::IsRelevant value");

  if (isRelevant && !mInEffectSet) {
    EffectSet* effectSet =
      EffectSet::GetOrCreateEffectSet(mTarget->mElement, mTarget->mPseudoType);
    effectSet->AddEffect(*this);
    mInEffectSet = true;
    UpdateEffectSet(effectSet);
    nsIFrame* f = mTarget->mElement->GetPrimaryFrame();
    while (f) {
      f->MarkNeedsDisplayItemRebuild();
      f = f->GetNextContinuation();
    }
  } else if (!isRelevant && mInEffectSet) {
    UnregisterTarget();
  }
}

void
KeyframeEffectReadOnly::UnregisterTarget()
{
  if (!mInEffectSet) {
    return;
  }

  EffectSet* effectSet =
    EffectSet::GetEffectSet(mTarget->mElement, mTarget->mPseudoType);
  MOZ_ASSERT(effectSet, "If mInEffectSet is true, there must be an EffectSet"
                        " on the target element");
  mInEffectSet = false;
  if (effectSet) {
    effectSet->RemoveEffect(*this);

    if (effectSet->IsEmpty()) {
      EffectSet::DestroyEffectSet(mTarget->mElement, mTarget->mPseudoType);
    }
  }
  nsIFrame* f = mTarget->mElement->GetPrimaryFrame();
  while (f) {
    f->MarkNeedsDisplayItemRebuild();
    f = f->GetNextContinuation();
  }
}

void
KeyframeEffectReadOnly::RequestRestyle(
  EffectCompositor::RestyleType aRestyleType)
{
   if (!mTarget) {
    return;
  }
  nsPresContext* presContext = nsContentUtils::GetContextForContent(mTarget->mElement);
  if (presContext && mAnimation) {
    presContext->EffectCompositor()->
      RequestRestyle(mTarget->mElement, mTarget->mPseudoType,
                     aRestyleType, mAnimation->CascadeLevel());
  }
}

already_AddRefed<ComputedStyle>
KeyframeEffectReadOnly::GetTargetComputedStyle()
{
  if (!GetRenderedDocument()) {
    return nullptr;
  }

  MOZ_ASSERT(mTarget,
             "Should only have a document when we have a target element");

  nsAtom* pseudo = mTarget->mPseudoType < CSSPseudoElementType::Count
                    ? nsCSSPseudoElements::GetPseudoAtom(mTarget->mPseudoType)
                    : nullptr;

  return nsComputedDOMStyle::GetComputedStyle(mTarget->mElement, pseudo);
}

#ifdef DEBUG
void
DumpAnimationProperties(nsTArray<AnimationProperty>& aAnimationProperties)
{
  for (auto& p : aAnimationProperties) {
    printf("%s\n", nsCSSProps::GetStringValue(p.mProperty).get());
    for (auto& s : p.mSegments) {
      nsString fromValue, toValue;
      s.mFromValue.SerializeSpecifiedValue(p.mProperty, fromValue);
      s.mToValue.SerializeSpecifiedValue(p.mProperty, toValue);
      printf("  %f..%f: %s..%s\n", s.mFromKey, s.mToKey,
             NS_ConvertUTF16toUTF8(fromValue).get(),
             NS_ConvertUTF16toUTF8(toValue).get());
    }
  }
}
#endif

/* static */ already_AddRefed<KeyframeEffectReadOnly>
KeyframeEffectReadOnly::Constructor(
    const GlobalObject& aGlobal,
    const Nullable<ElementOrCSSPseudoElement>& aTarget,
    JS::Handle<JSObject*> aKeyframes,
    const UnrestrictedDoubleOrKeyframeEffectOptions& aOptions,
    ErrorResult& aRv)
{
  return ConstructKeyframeEffect<KeyframeEffectReadOnly>(aGlobal, aTarget,
                                                         aKeyframes, aOptions,
                                                         aRv);
}

/* static */ already_AddRefed<KeyframeEffectReadOnly>
KeyframeEffectReadOnly::Constructor(const GlobalObject& aGlobal,
                                    KeyframeEffectReadOnly& aSource,
                                    ErrorResult& aRv)
{
  return ConstructKeyframeEffect<KeyframeEffectReadOnly>(aGlobal, aSource, aRv);
}

void
KeyframeEffectReadOnly::GetTarget(
    Nullable<OwningElementOrCSSPseudoElement>& aRv) const
{
  if (!mTarget) {
    aRv.SetNull();
    return;
  }

  switch (mTarget->mPseudoType) {
    case CSSPseudoElementType::before:
    case CSSPseudoElementType::after:
      aRv.SetValue().SetAsCSSPseudoElement() =
        CSSPseudoElement::GetCSSPseudoElement(mTarget->mElement,
                                              mTarget->mPseudoType);
      break;

    case CSSPseudoElementType::NotPseudo:
      aRv.SetValue().SetAsElement() = mTarget->mElement;
      break;

    default:
      NS_NOTREACHED("Animation of unsupported pseudo-type");
      aRv.SetNull();
  }
}

static void
CreatePropertyValue(nsCSSPropertyID aProperty,
                    float aOffset,
                    const Maybe<ComputedTimingFunction>& aTimingFunction,
                    const AnimationValue& aValue,
                    dom::CompositeOperation aComposite,
                    AnimationPropertyValueDetails& aResult)
{
  aResult.mOffset = aOffset;

  if (!aValue.IsNull()) {
    nsString stringValue;
    aValue.SerializeSpecifiedValue(aProperty, stringValue);
    aResult.mValue.Construct(stringValue);
  }

  if (aTimingFunction) {
    aResult.mEasing.Construct();
    aTimingFunction->AppendToString(aResult.mEasing.Value());
  } else {
    aResult.mEasing.Construct(NS_LITERAL_STRING("linear"));
  }

  aResult.mComposite = aComposite;
}

void
KeyframeEffectReadOnly::GetProperties(
    nsTArray<AnimationPropertyDetails>& aProperties,
    ErrorResult& aRv) const
{
  for (const AnimationProperty& property : mProperties) {
    AnimationPropertyDetails propertyDetails;
    propertyDetails.mProperty =
      NS_ConvertASCIItoUTF16(nsCSSProps::GetStringValue(property.mProperty));
    propertyDetails.mRunningOnCompositor = property.mIsRunningOnCompositor;

    nsAutoString localizedString;
    if (property.mPerformanceWarning &&
        property.mPerformanceWarning->ToLocalizedString(localizedString)) {
      propertyDetails.mWarning.Construct(localizedString);
    }

    if (!propertyDetails.mValues.SetCapacity(property.mSegments.Length(),
                                             mozilla::fallible)) {
      aRv.Throw(NS_ERROR_OUT_OF_MEMORY);
      return;
    }

    for (size_t segmentIdx = 0, segmentLen = property.mSegments.Length();
         segmentIdx < segmentLen;
         segmentIdx++)
    {
      const AnimationPropertySegment& segment = property.mSegments[segmentIdx];

      binding_detail::FastAnimationPropertyValueDetails fromValue;
      CreatePropertyValue(property.mProperty, segment.mFromKey,
                          segment.mTimingFunction, segment.mFromValue,
                          segment.mFromComposite, fromValue);
      // We don't apply timing functions for zero-length segments, so
      // don't return one here.
      if (segment.mFromKey == segment.mToKey) {
        fromValue.mEasing.Reset();
      }
      // The following won't fail since we have already allocated the capacity
      // above.
      propertyDetails.mValues.AppendElement(fromValue, mozilla::fallible);

      // Normally we can ignore the to-value for this segment since it is
      // identical to the from-value from the next segment. However, we need
      // to add it if either:
      // a) this is the last segment, or
      // b) the next segment's from-value differs.
      if (segmentIdx == segmentLen - 1 ||
          property.mSegments[segmentIdx + 1].mFromValue != segment.mToValue) {
        binding_detail::FastAnimationPropertyValueDetails toValue;
        CreatePropertyValue(property.mProperty, segment.mToKey,
                            Nothing(), segment.mToValue,
                            segment.mToComposite, toValue);
        // It doesn't really make sense to have a timing function on the
        // last property value or before a sudden jump so we just drop the
        // easing property altogether.
        toValue.mEasing.Reset();
        propertyDetails.mValues.AppendElement(toValue, mozilla::fallible);
      }
    }

    aProperties.AppendElement(propertyDetails);
  }
}

void
KeyframeEffectReadOnly::GetKeyframes(JSContext*& aCx,
                                     nsTArray<JSObject*>& aResult,
                                     ErrorResult& aRv)
{
  MOZ_ASSERT(aResult.IsEmpty());
  MOZ_ASSERT(!aRv.Failed());

  if (!aResult.SetCapacity(mKeyframes.Length(), mozilla::fallible)) {
    aRv.Throw(NS_ERROR_OUT_OF_MEMORY);
    return;
  }

  bool isCSSAnimation = mAnimation && mAnimation->AsCSSAnimation();

  // For Servo, when we have CSS Animation @keyframes with variables, we convert
  // shorthands to longhands if needed, and store a reference to the unparsed
  // value. When it comes time to serialize, however, what do you serialize for
  // a longhand that comes from a variable reference in a shorthand? Servo says,
  // "an empty string" which is not particularly helpful.
  //
  // We should just store shorthands as-is (bug 1391537) and then return the
  // variable references, but for now, since we don't do that, and in order to
  // be consistent with Gecko, we just expand the variables (assuming we have
  // enough context to do so). For that we need to grab the ComputedStyle so we
  // know what custom property values to provide.
  RefPtr<ComputedStyle> computedStyle;
  if (isCSSAnimation) {
    // The following will flush style but that's ok since if you update
    // a variable's computed value, you expect to see that updated value in the
    // result of getKeyframes().
    //
    // If we don't have a target, the following will return null. In that case
    // we might end up returning variables as-is or empty string. That should be
    // acceptable however, since such a case is rare and this is only
    // short-term (and unshipped) behavior until bug 1391537 is fixed.
    computedStyle = GetTargetComputedStyle();
  }

  for (const Keyframe& keyframe : mKeyframes) {
    // Set up a dictionary object for the explicit members
    BaseComputedKeyframe keyframeDict;
    if (keyframe.mOffset) {
      keyframeDict.mOffset.SetValue(keyframe.mOffset.value());
    }
    MOZ_ASSERT(keyframe.mComputedOffset != Keyframe::kComputedOffsetNotSet,
               "Invalid computed offset");
    keyframeDict.mComputedOffset.Construct(keyframe.mComputedOffset);
    if (keyframe.mTimingFunction) {
      keyframeDict.mEasing.Truncate();
      keyframe.mTimingFunction.ref().AppendToString(keyframeDict.mEasing);
    } // else if null, leave easing as its default "linear".

    if (keyframe.mComposite) {
      keyframeDict.mComposite.SetValue(keyframe.mComposite.value());
    }

    JS::Rooted<JS::Value> keyframeJSValue(aCx);
    if (!ToJSValue(aCx, keyframeDict, &keyframeJSValue)) {
      aRv.Throw(NS_ERROR_FAILURE);
      return;
    }

    RefPtr<RawServoDeclarationBlock> customProperties;
    // A workaround for CSS Animations in servo backend, custom properties in
    // keyframe are stored in a servo's declaration block. Find the declaration
    // block to resolve CSS variables in the keyframe.
    // This workaround will be solved by bug 1391537.
    if (isCSSAnimation) {
      for (const PropertyValuePair& propertyValue : keyframe.mPropertyValues) {
        if (propertyValue.mProperty ==
              nsCSSPropertyID::eCSSPropertyExtra_variable) {
          customProperties = propertyValue.mServoDeclarationBlock;
          break;
        }
      }
    }

    JS::Rooted<JSObject*> keyframeObject(aCx, &keyframeJSValue.toObject());
    for (const PropertyValuePair& propertyValue : keyframe.mPropertyValues) {
      nsAutoString stringValue;
      // Don't serialize the custom properties for this keyframe.
      if (propertyValue.mProperty ==
            nsCSSPropertyID::eCSSPropertyExtra_variable) {
        continue;
      }
      if (propertyValue.mServoDeclarationBlock) {
        Servo_DeclarationBlock_SerializeOneValue(
          propertyValue.mServoDeclarationBlock,
          propertyValue.mProperty,
          &stringValue,
          computedStyle,
          customProperties);
      } else {
        RawServoAnimationValue* value =
          mBaseStyleValuesForServo.GetWeak(propertyValue.mProperty);

        if (value) {
          Servo_AnimationValue_Serialize(value,
                                         propertyValue.mProperty,
                                         &stringValue);
        }
      }

      const char* name = nsCSSProps::PropertyIDLName(propertyValue.mProperty);
      JS::Rooted<JS::Value> value(aCx);
      if (!ToJSValue(aCx, stringValue, &value) ||
          !JS_DefineProperty(aCx, keyframeObject, name, value,
                             JSPROP_ENUMERATE)) {
        aRv.Throw(NS_ERROR_FAILURE);
        return;
      }
    }

    aResult.AppendElement(keyframeObject);
  }
}

/* static */ const TimeDuration
KeyframeEffectReadOnly::OverflowRegionRefreshInterval()
{
  // The amount of time we can wait between updating throttled animations
  // on the main thread that influence the overflow region.
  static const TimeDuration kOverflowRegionRefreshInterval =
    TimeDuration::FromMilliseconds(200);

  return kOverflowRegionRefreshInterval;
}

bool
KeyframeEffectReadOnly::CanThrottle() const
{
  // Unthrottle if we are not in effect or current. This will be the case when
  // our owning animation has finished, is idle, or when we are in the delay
  // phase (but without a backwards fill). In each case the computed progress
  // value produced on each tick will be the same so we will skip requesting
  // unnecessary restyles in NotifyAnimationTimingUpdated. Any calls we *do* get
  // here will be because of a change in state (e.g. we are newly finished or
  // newly no longer in effect) in which case we shouldn't throttle the sample.
  if (!IsInEffect() || !IsCurrent()) {
    return false;
  }

  nsIFrame* frame = GetAnimationFrame();
  if (!frame) {
    // There are two possible cases here.
    // a) No target element
    // b) The target element has no frame, e.g. because it is in a display:none
    //    subtree.
    // In either case we can throttle the animation because there is no
    // need to update on the main thread.
    return true;
  }

  // Unless we are newly in-effect, we can throttle the animation if the
  // animation is paint only and the target frame is out of view or the document
  // is in background tabs.
  if (mInEffectOnLastAnimationTimingUpdate && CanIgnoreIfNotVisible()) {
    nsIPresShell* presShell = GetPresShell();
    if (presShell && !presShell->IsActive()) {
      return true;
    }

    const bool isVisibilityHidden =
      !frame->IsVisibleOrMayHaveVisibleDescendants();
    if (isVisibilityHidden ||
        frame->IsScrolledOutOfView()) {
      // If there are transform change hints, unthrottle the animation
      // periodically since it might affect the overflow region.
      if (HasTransformThatMightAffectOverflow()) {
        // Don't throttle finite transform animations since the animation might
        // suddenly come into view and if it was throttled it will be
        // out-of-sync.
        if (HasFiniteActiveDuration()) {
          return false;
        }

        return isVisibilityHidden
          ? CanThrottleTransformChangesInScrollable(*frame)
          : CanThrottleTransformChanges(*frame);
      }
      return true;
    }
  }

  // First we need to check layer generation and transform overflow
  // prior to the property.mIsRunningOnCompositor check because we should
  // occasionally unthrottle these animations even if the animations are
  // already running on compositor.
  for (const LayerAnimationInfo::Record& record :
        LayerAnimationInfo::sRecords) {
    // Skip properties that are overridden by !important rules.
    // (GetEffectiveAnimationOfProperty, as called by
    // HasEffectiveAnimationOfProperty, only returns a property which is
    // neither overridden by !important rules nor overridden by other
    // animation.)
    if (!HasEffectiveAnimationOfProperty(record.mProperty)) {
      continue;
    }

    EffectSet* effectSet = EffectSet::GetEffectSet(mTarget->mElement,
                                                   mTarget->mPseudoType);
    MOZ_ASSERT(effectSet, "CanThrottle should be called on an effect "
                          "associated with a target element");
    layers::Layer* layer =
      FrameLayerBuilder::GetDedicatedLayer(frame, record.mLayerType);
    // Unthrottle if the layer needs to be brought up to date
    if (!layer ||
        effectSet->GetAnimationGeneration() !=
          layer->GetAnimationGeneration()) {
      return false;
    }

    // If this is a transform animation that affects the overflow region,
    // we should unthrottle the animation periodically.
    if (HasTransformThatMightAffectOverflow() &&
        !CanThrottleTransformChangesInScrollable(*frame)) {
      return false;
    }
  }

  for (const AnimationProperty& property : mProperties) {
    if (!property.mIsRunningOnCompositor) {
      return false;
    }
  }

  return true;
}

bool
KeyframeEffectReadOnly::CanThrottleTransformChanges(const nsIFrame& aFrame) const
{
  TimeStamp now = aFrame.PresContext()->RefreshDriver()->MostRecentRefresh();

  EffectSet* effectSet = EffectSet::GetEffectSet(mTarget->mElement,
                                                 mTarget->mPseudoType);
  MOZ_ASSERT(effectSet, "CanThrottleTransformChanges is expected to be called"
                        " on an effect in an effect set");
  MOZ_ASSERT(mAnimation, "CanThrottleTransformChanges is expected to be called"
                         " on an effect with a parent animation");
  TimeStamp lastSyncTime = effectSet->LastTransformSyncTime();
  // If this animation can cause overflow, we can throttle some of the ticks.
  return (!lastSyncTime.IsNull() &&
    (now - lastSyncTime) < OverflowRegionRefreshInterval());
}

bool
KeyframeEffectReadOnly::CanThrottleTransformChangesInScrollable(nsIFrame& aFrame) const
{
  // If the target element is not associated with any documents, we don't care
  // it.
  nsIDocument* doc = GetRenderedDocument();
  if (!doc) {
    return true;
  }

  bool hasIntersectionObservers = doc->HasIntersectionObservers();

  // If we know that the animation cannot cause overflow,
  // we can just disable flushes for this animation.

  // If we don't show scrollbars and have no intersection observers, we don't
  // care about overflow.
  if (LookAndFeel::GetInt(LookAndFeel::eIntID_ShowHideScrollbars) == 0 &&
      !hasIntersectionObservers) {
    return true;
  }

  if (CanThrottleTransformChanges(aFrame)) {
    return true;
  }

  // If we have any intersection observers, we unthrottle this transform
  // animation periodically.
  if (hasIntersectionObservers) {
    return false;
  }

  // If the nearest scrollable ancestor has overflow:hidden,
  // we don't care about overflow.
  nsIScrollableFrame* scrollable =
    nsLayoutUtils::GetNearestScrollableFrame(&aFrame);
  if (!scrollable) {
    return true;
  }

  ScrollbarStyles ss = scrollable->GetScrollbarStyles();
  if (ss.mVertical == NS_STYLE_OVERFLOW_HIDDEN &&
      ss.mHorizontal == NS_STYLE_OVERFLOW_HIDDEN &&
      scrollable->GetLogicalScrollPosition() == nsPoint(0, 0)) {
    return true;
  }

  return false;
}

nsIFrame*
KeyframeEffectReadOnly::GetAnimationFrame() const
{
  if (!mTarget) {
    return nullptr;
  }

  nsIFrame* frame;
  if (mTarget->mPseudoType == CSSPseudoElementType::before) {
    frame = nsLayoutUtils::GetBeforeFrame(mTarget->mElement);
  } else if (mTarget->mPseudoType == CSSPseudoElementType::after) {
    frame = nsLayoutUtils::GetAfterFrame(mTarget->mElement);
  } else {
    frame = mTarget->mElement->GetPrimaryFrame();
    MOZ_ASSERT(mTarget->mPseudoType == CSSPseudoElementType::NotPseudo,
               "unknown mTarget->mPseudoType");
  }

  if (!frame) {
    return nullptr;
  }

  return nsLayoutUtils::GetStyleFrame(frame);
}

nsIDocument*
KeyframeEffectReadOnly::GetRenderedDocument() const
{
  if (!mTarget) {
    return nullptr;
  }
  return mTarget->mElement->GetComposedDoc();
}

nsIPresShell*
KeyframeEffectReadOnly::GetPresShell() const
{
  nsIDocument* doc = GetRenderedDocument();
  if (!doc) {
    return nullptr;
  }
  return doc->GetShell();
}

/* static */ bool
KeyframeEffectReadOnly::IsGeometricProperty(
  const nsCSSPropertyID aProperty)
{
  MOZ_ASSERT(!nsCSSProps::IsShorthand(aProperty),
             "Property should be a longhand property");

  switch (aProperty) {
    case eCSSProperty_bottom:
    case eCSSProperty_height:
    case eCSSProperty_left:
    case eCSSProperty_margin_bottom:
    case eCSSProperty_margin_left:
    case eCSSProperty_margin_right:
    case eCSSProperty_margin_top:
    case eCSSProperty_padding_bottom:
    case eCSSProperty_padding_left:
    case eCSSProperty_padding_right:
    case eCSSProperty_padding_top:
    case eCSSProperty_right:
    case eCSSProperty_top:
    case eCSSProperty_width:
      return true;
    default:
      return false;
  }
}

/* static */ bool
KeyframeEffectReadOnly::CanAnimateTransformOnCompositor(
  const nsIFrame* aFrame,
  AnimationPerformanceWarning::Type& aPerformanceWarning)
{
  // Disallow OMTA for preserve-3d transform. Note that we check the style property
  // rather than Extend3DContext() since that can recurse back into this function
  // via HasOpacity(). See bug 779598.
  if (aFrame->Combines3DTransformWithAncestors() ||
      aFrame->StyleDisplay()->mTransformStyle == NS_STYLE_TRANSFORM_STYLE_PRESERVE_3D) {
    aPerformanceWarning = AnimationPerformanceWarning::Type::TransformPreserve3D;
    return false;
  }
  // Note that testing BackfaceIsHidden() is not a sufficient test for
  // what we need for animating backface-visibility correctly if we
  // remove the above test for Extend3DContext(); that would require
  // looking at backface-visibility on descendants as well. See bug 1186204.
  if (aFrame->BackfaceIsHidden()) {
    aPerformanceWarning =
      AnimationPerformanceWarning::Type::TransformBackfaceVisibilityHidden;
    return false;
  }
  // Async 'transform' animations of aFrames with SVG transforms is not
  // supported.  See bug 779599.
  if (aFrame->IsSVGTransformed()) {
    aPerformanceWarning = AnimationPerformanceWarning::Type::TransformSVG;
    return false;
  }

  return true;
}

bool
KeyframeEffectReadOnly::ShouldBlockAsyncTransformAnimations(
  const nsIFrame* aFrame,
  AnimationPerformanceWarning::Type& aPerformanceWarning) const
{
  EffectSet* effectSet =
    EffectSet::GetEffectSet(mTarget->mElement, mTarget->mPseudoType);
  for (const AnimationProperty& property : mProperties) {
    // If there is a property for animations level that is overridden by
    // !important rules, it should not block other animations from running
    // on the compositor.
    // NOTE: We don't currently check for !important rules for properties that
    // don't run on the compositor. As result such properties (e.g. margin-left)
    // can still block async animations even if they are overridden by
    // !important rules.
    if (effectSet &&
        effectSet->PropertiesWithImportantRules()
          .HasProperty(property.mProperty) &&
        effectSet->PropertiesForAnimationsLevel()
          .HasProperty(property.mProperty)) {
      continue;
    }
    // Check for geometric properties
    if (IsGeometricProperty(property.mProperty)) {
      aPerformanceWarning =
        AnimationPerformanceWarning::Type::TransformWithGeometricProperties;
      return true;
    }

    // Check for unsupported transform animations
    if (property.mProperty == eCSSProperty_transform) {
      if (!CanAnimateTransformOnCompositor(aFrame,
                                           aPerformanceWarning)) {
        return true;
      }
    }
  }

  // XXX cku temporarily disable async-animation when this frame has any
  // individual transforms before bug 1425837 been fixed.
  if (aFrame->StyleDisplay()->HasIndividualTransform()) {
    return true;
  }

  return false;
}

bool
KeyframeEffectReadOnly::HasGeometricProperties() const
{
  for (const AnimationProperty& property : mProperties) {
    if (IsGeometricProperty(property.mProperty)) {
      return true;
    }
  }

  return false;
}

void
KeyframeEffectReadOnly::SetPerformanceWarning(
  nsCSSPropertyID aProperty,
  const AnimationPerformanceWarning& aWarning)
{
  for (AnimationProperty& property : mProperties) {
    if (property.mProperty == aProperty &&
        (!property.mPerformanceWarning ||
         *property.mPerformanceWarning != aWarning)) {
      property.mPerformanceWarning = Some(aWarning);

      nsAutoString localizedString;
      if (nsLayoutUtils::IsAnimationLoggingEnabled() &&
          property.mPerformanceWarning->ToLocalizedString(localizedString)) {
        nsAutoCString logMessage = NS_ConvertUTF16toUTF8(localizedString);
        AnimationUtils::LogAsyncAnimationFailure(logMessage, mTarget->mElement);
      }
      return;
    }
  }
}


already_AddRefed<ComputedStyle>
KeyframeEffectReadOnly::CreateComputedStyleForAnimationValue(
  nsCSSPropertyID aProperty,
  const AnimationValue& aValue,
  const ComputedStyle* aBaseComputedStyle)
{
  MOZ_ASSERT(aBaseComputedStyle,
             "CreateComputedStyleForAnimationValue needs to be called "
             "with a valid ComputedStyle");

  ServoStyleSet* styleSet = aBaseComputedStyle->PresContext()->StyleSet();
  Element* elementForResolve =
    EffectCompositor::GetElementToRestyle(mTarget->mElement,
                                          mTarget->mPseudoType);
  MOZ_ASSERT(elementForResolve, "The target element shouldn't be null");
  return styleSet->ResolveServoStyleByAddingAnimation(elementForResolve,
                                                      aBaseComputedStyle,
                                                      aValue.mServo);
}

template<typename StyleType>
void
KeyframeEffectReadOnly::CalculateCumulativeChangeHint(StyleType* aComputedStyle)
{
  mCumulativeChangeHint = nsChangeHint(0);

  for (const AnimationProperty& property : mProperties) {
    // For opacity property we don't produce any change hints that are not
    // included in nsChangeHint_Hints_CanIgnoreIfNotVisible so we can throttle
    // opacity animations regardless of the change they produce.  This
    // optimization is particularly important since it allows us to throttle
    // opacity animations with missing 0%/100% keyframes.
    if (property.mProperty == eCSSProperty_opacity) {
      continue;
    }

    for (const AnimationPropertySegment& segment : property.mSegments) {
      // In case composite operation is not 'replace' or value is null,
      // we can't throttle animations which will not cause any layout changes
      // on invisible elements because we can't calculate the change hint for
      // such properties until we compose it.
      if (!segment.HasReplaceableValues()) {
        mCumulativeChangeHint = ~nsChangeHint_Hints_CanIgnoreIfNotVisible;
        return;
      }
      RefPtr<ComputedStyle> fromContext =
        CreateComputedStyleForAnimationValue(property.mProperty,
                                            segment.mFromValue,
                                            aComputedStyle);
      if (!fromContext) {
        mCumulativeChangeHint = ~nsChangeHint_Hints_CanIgnoreIfNotVisible;
        return;
      }

      RefPtr<ComputedStyle> toContext =
        CreateComputedStyleForAnimationValue(property.mProperty,
                                            segment.mToValue,
                                            aComputedStyle);
      if (!toContext) {
        mCumulativeChangeHint = ~nsChangeHint_Hints_CanIgnoreIfNotVisible;
        return;
      }

      uint32_t equalStructs = 0;
      nsChangeHint changeHint =
        fromContext->CalcStyleDifference(toContext, &equalStructs);

      mCumulativeChangeHint |= changeHint;
    }
  }
}

void
KeyframeEffectReadOnly::SetAnimation(Animation* aAnimation)
{
  if (mAnimation == aAnimation) {
    return;
  }

  // Restyle for the old animation.
  RequestRestyle(EffectCompositor::RestyleType::Layer);

  mAnimation = aAnimation;

  // The order of these function calls is important:
  // NotifyAnimationTimingUpdated() need the updated mIsRelevant flag to check
  // if it should create the effectSet or not, and MarkCascadeNeedsUpdate()
  // needs a valid effectSet, so we should call them in this order.
  if (mAnimation) {
    mAnimation->UpdateRelevance();
  }
  NotifyAnimationTimingUpdated();
  if (mAnimation) {
    MarkCascadeNeedsUpdate();
  }
}

bool
KeyframeEffectReadOnly::CanIgnoreIfNotVisible() const
{
  if (!AnimationUtils::IsOffscreenThrottlingEnabled()) {
    return false;
  }

  // FIXME: For further sophisticated optimization we need to check
  // change hint on the segment corresponding to computedTiming.progress.
  return NS_IsHintSubset(
    mCumulativeChangeHint, nsChangeHint_Hints_CanIgnoreIfNotVisible);
}

void
KeyframeEffectReadOnly::MaybeUpdateFrameForCompositor()
{
  nsIFrame* frame = GetAnimationFrame();
  if (!frame) {
    return;
  }

  // FIXME: Bug 1272495: If this effect does not win in the cascade, the
  // NS_FRAME_MAY_BE_TRANSFORMED flag should be removed when the animation
  // will be removed from effect set or the transform keyframes are removed
  // by setKeyframes. The latter case will be hard to solve though.
  for (const AnimationProperty& property : mProperties) {
    if (property.mProperty == eCSSProperty_transform) {
      frame->AddStateBits(NS_FRAME_MAY_BE_TRANSFORMED);
      return;
    }
  }
}

void
KeyframeEffectReadOnly::MarkCascadeNeedsUpdate()
{
  if (!mTarget) {
    return;
  }

  EffectSet* effectSet = EffectSet::GetEffectSet(mTarget->mElement,
                                                 mTarget->mPseudoType);
  if (!effectSet) {
    return;
  }
  effectSet->MarkCascadeNeedsUpdate();
}

bool
KeyframeEffectReadOnly::HasComputedTimingChanged() const
{
  // Typically we don't need to request a restyle if the progress hasn't
  // changed since the last call to ComposeStyle. The one exception is if the
  // iteration composite mode is 'accumulate' and the current iteration has
  // changed, since that will often produce a different result.
  ComputedTiming computedTiming = GetComputedTiming();
  return computedTiming.mProgress != mProgressOnLastCompose ||
         (mEffectOptions.mIterationComposite ==
            IterationCompositeOperation::Accumulate &&
         computedTiming.mCurrentIteration !=
          mCurrentIterationOnLastCompose);
}

bool
KeyframeEffectReadOnly::ContainsAnimatedScale(const nsIFrame* aFrame) const
{
  if (!IsCurrent()) {
    return false;
  }

  for (const AnimationProperty& prop : mProperties) {
    if (prop.mProperty != eCSSProperty_transform) {
      continue;
    }

    AnimationValue baseStyle = BaseStyle(prop.mProperty);
    if (baseStyle.IsNull()) {
      // If we failed to get the base style, we consider it has scale value
      // here just to be safe.
      return true;
    }
    gfx::Size size = baseStyle.GetScaleValue(aFrame);
    if (size != gfx::Size(1.0f, 1.0f)) {
      return true;
    }

    // This is actually overestimate because there are some cases that combining
    // the base value and from/to value produces 1:1 scale. But it doesn't
    // really matter.
    for (const AnimationPropertySegment& segment : prop.mSegments) {
      if (!segment.mFromValue.IsNull()) {
        gfx::Size from = segment.mFromValue.GetScaleValue(aFrame);
        if (from != gfx::Size(1.0f, 1.0f)) {
          return true;
        }
      }
      if (!segment.mToValue.IsNull()) {
        gfx::Size to = segment.mToValue.GetScaleValue(aFrame);
        if (to != gfx::Size(1.0f, 1.0f)) {
          return true;
        }
      }
    }
  }

  return false;
}

void
KeyframeEffectReadOnly::UpdateEffectSet(EffectSet* aEffectSet) const
{
  if (!mInEffectSet) {
    return;
  }

  EffectSet* effectSet =
    aEffectSet ? aEffectSet
               : EffectSet::GetEffectSet(mTarget->mElement,
                                         mTarget->mPseudoType);
  if (!effectSet) {
    return;
  }

  nsIFrame* frame = GetAnimationFrame();
  if (HasAnimationOfProperty(eCSSProperty_opacity)) {
    effectSet->SetMayHaveOpacityAnimation();
    if (frame) {
      frame->SetMayHaveOpacityAnimation();
    }
  }
  if (HasAnimationOfProperty(eCSSProperty_transform)) {
    effectSet->SetMayHaveTransformAnimation();
    if (frame) {
      frame->SetMayHaveTransformAnimation();
    }
  }
}


template
void
KeyframeEffectReadOnly::ComposeStyle<RawServoAnimationValueMap&>(
  RawServoAnimationValueMap& aAnimationValues,
  const nsCSSPropertyIDSet& aPropertiesToSkip);

} // namespace dom
} // namespace mozilla
