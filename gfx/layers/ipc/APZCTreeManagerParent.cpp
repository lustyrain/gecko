/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ts=8 sts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/layers/APZCTreeManagerParent.h"

#include "apz/src/APZCTreeManager.h"
#include "mozilla/layers/APZThreadUtils.h"
#include "mozilla/layers/APZUpdater.h"

namespace mozilla {
namespace layers {

APZCTreeManagerParent::APZCTreeManagerParent(LayersId aLayersId,
                                             RefPtr<APZCTreeManager> aAPZCTreeManager,
                                             RefPtr<APZUpdater> aAPZUpdater)
  : mLayersId(aLayersId)
  , mTreeManager(Move(aAPZCTreeManager))
  , mUpdater(Move(aAPZUpdater))
{
  MOZ_ASSERT(mTreeManager != nullptr);
  MOZ_ASSERT(mUpdater != nullptr);
  MOZ_ASSERT(mUpdater->HasTreeManager(mTreeManager));
}

APZCTreeManagerParent::~APZCTreeManagerParent()
{
}

void
APZCTreeManagerParent::ChildAdopted(RefPtr<APZCTreeManager> aAPZCTreeManager,
                                    RefPtr<APZUpdater> aAPZUpdater)
{
  MOZ_ASSERT(aAPZCTreeManager != nullptr);
  MOZ_ASSERT(aAPZUpdater != nullptr);
  MOZ_ASSERT(aAPZUpdater->HasTreeManager(aAPZCTreeManager));
  mTreeManager = Move(aAPZCTreeManager);
  mUpdater = Move(aAPZUpdater);
}

mozilla::ipc::IPCResult
APZCTreeManagerParent::RecvSetKeyboardMap(const KeyboardMap& aKeyboardMap)
{
  mUpdater->RunOnControllerThread(NewRunnableMethod<KeyboardMap>(
    "layers::IAPZCTreeManager::SetKeyboardMap",
    mTreeManager,
    &IAPZCTreeManager::SetKeyboardMap,
    aKeyboardMap));

  return IPC_OK();
}

mozilla::ipc::IPCResult
APZCTreeManagerParent::RecvZoomToRect(
    const ScrollableLayerGuid& aGuid,
    const CSSRect& aRect,
    const uint32_t& aFlags)
{
  if (aGuid.mLayersId != mLayersId) {
    // Guard against bad data from hijacked child processes
    NS_ERROR("Unexpected layers id in RecvZoomToRect; dropping message...");
    return IPC_FAIL_NO_REASON(this);
  }

  mUpdater->RunOnControllerThread(
    NewRunnableMethod<ScrollableLayerGuid, CSSRect, uint32_t>(
      "layers::IAPZCTreeManager::ZoomToRect",
      mTreeManager,
      &IAPZCTreeManager::ZoomToRect,
      aGuid, aRect, aFlags));
  return IPC_OK();
}

mozilla::ipc::IPCResult
APZCTreeManagerParent::RecvContentReceivedInputBlock(
    const uint64_t& aInputBlockId,
    const bool& aPreventDefault)
{
  mUpdater->RunOnControllerThread(NewRunnableMethod<uint64_t, bool>(
    "layers::IAPZCTreeManager::ContentReceivedInputBlock",
    mTreeManager,
    &IAPZCTreeManager::ContentReceivedInputBlock,
    aInputBlockId,
    aPreventDefault));

  return IPC_OK();
}

mozilla::ipc::IPCResult
APZCTreeManagerParent::RecvSetTargetAPZC(
    const uint64_t& aInputBlockId,
    nsTArray<ScrollableLayerGuid>&& aTargets)
{
  for (size_t i = 0; i < aTargets.Length(); i++) {
    if (aTargets[i].mLayersId != mLayersId) {
      // Guard against bad data from hijacked child processes
      NS_ERROR("Unexpected layers id in RecvSetTargetAPZC; dropping message...");
      return IPC_FAIL_NO_REASON(this);
    }
  }
  mUpdater->RunOnControllerThread(
    NewRunnableMethod<uint64_t,
                      StoreCopyPassByRRef<nsTArray<ScrollableLayerGuid>>>(
      "layers::IAPZCTreeManager::SetTargetAPZC",
      mTreeManager,
      &IAPZCTreeManager::SetTargetAPZC,
      aInputBlockId,
      aTargets));

  return IPC_OK();
}

mozilla::ipc::IPCResult
APZCTreeManagerParent::RecvUpdateZoomConstraints(
    const ScrollableLayerGuid& aGuid,
    const MaybeZoomConstraints& aConstraints)
{
  if (aGuid.mLayersId != mLayersId) {
    // Guard against bad data from hijacked child processes
    NS_ERROR("Unexpected layers id in RecvUpdateZoomConstraints; dropping message...");
    return IPC_FAIL_NO_REASON(this);
  }

  mTreeManager->UpdateZoomConstraints(aGuid, aConstraints);
  return IPC_OK();
}

mozilla::ipc::IPCResult
APZCTreeManagerParent::RecvSetDPI(const float& aDpiValue)
{
  mUpdater->RunOnControllerThread(NewRunnableMethod<float>(
    "layers::IAPZCTreeManager::SetDPI",
    mTreeManager,
    &IAPZCTreeManager::SetDPI,
    aDpiValue));
  return IPC_OK();
}

mozilla::ipc::IPCResult
APZCTreeManagerParent::RecvSetAllowedTouchBehavior(
    const uint64_t& aInputBlockId,
    nsTArray<TouchBehaviorFlags>&& aValues)
{
  mUpdater->RunOnControllerThread(
    NewRunnableMethod<uint64_t,
                      StoreCopyPassByRRef<nsTArray<TouchBehaviorFlags>>>(
      "layers::IAPZCTreeManager::SetAllowedTouchBehavior",
      mTreeManager,
      &IAPZCTreeManager::SetAllowedTouchBehavior,
      aInputBlockId,
      Move(aValues)));

  return IPC_OK();
}

mozilla::ipc::IPCResult
APZCTreeManagerParent::RecvStartScrollbarDrag(
    const ScrollableLayerGuid& aGuid,
    const AsyncDragMetrics& aDragMetrics)
{
  if (aGuid.mLayersId != mLayersId) {
    // Guard against bad data from hijacked child processes
    NS_ERROR("Unexpected layers id in RecvStartScrollbarDrag; dropping message...");
    return IPC_FAIL_NO_REASON(this);
  }

  mUpdater->RunOnControllerThread(
    NewRunnableMethod<ScrollableLayerGuid, AsyncDragMetrics>(
      "layers::IAPZCTreeManager::StartScrollbarDrag",
      mTreeManager,
      &IAPZCTreeManager::StartScrollbarDrag,
      aGuid,
      aDragMetrics));

  return IPC_OK();
}

mozilla::ipc::IPCResult
APZCTreeManagerParent::RecvStartAutoscroll(
    const ScrollableLayerGuid& aGuid,
    const ScreenPoint& aAnchorLocation)
{
  // Unlike RecvStartScrollbarDrag(), this message comes from the parent
  // process (via nsBaseWidget::mAPZC) rather than from the child process
  // (via TabChild::mApzcTreeManager), so there is no need to check the
  // layers id against mLayersId (and in any case, it wouldn't match, because
  // mLayersId stores the parent process's layers id, while nsBaseWidget is
  // sending the child process's layers id).

  mUpdater->RunOnControllerThread(
      NewRunnableMethod<ScrollableLayerGuid, ScreenPoint>(
        "layers::IAPZCTreeManager::StartAutoscroll",
        mTreeManager,
        &IAPZCTreeManager::StartAutoscroll,
        aGuid, aAnchorLocation));

  return IPC_OK();
}

mozilla::ipc::IPCResult
APZCTreeManagerParent::RecvStopAutoscroll(const ScrollableLayerGuid& aGuid)
{
  // See RecvStartAutoscroll() for why we don't check the layers id.

  mUpdater->RunOnControllerThread(
      NewRunnableMethod<ScrollableLayerGuid>(
        "layers::IAPZCTreeManager::StopAutoscroll",
        mTreeManager,
        &IAPZCTreeManager::StopAutoscroll,
        aGuid));

  return IPC_OK();
}

mozilla::ipc::IPCResult
APZCTreeManagerParent::RecvSetLongTapEnabled(const bool& aLongTapEnabled)
{
  mUpdater->RunOnControllerThread(
      NewRunnableMethod<bool>(
        "layers::IAPZCTreeManager::SetLongTapEnabled",
        mTreeManager,
        &IAPZCTreeManager::SetLongTapEnabled,
        aLongTapEnabled));

  return IPC_OK();
}

} // namespace layers
} // namespace mozilla
