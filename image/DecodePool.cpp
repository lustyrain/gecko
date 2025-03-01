/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "DecodePool.h"

#include <algorithm>

#include "mozilla/ClearOnShutdown.h"
#include "mozilla/DebugOnly.h"
#include "mozilla/Monitor.h"
#include "nsCOMPtr.h"
#include "nsIObserverService.h"
#include "nsIThreadPool.h"
#include "nsThreadManager.h"
#include "nsThreadUtils.h"
#include "nsXPCOMCIDInternal.h"
#include "prsystem.h"
#include "nsIXULRuntime.h"

#include "gfxPrefs.h"

#include "Decoder.h"
#include "IDecodingTask.h"
#include "RasterImage.h"

using std::max;
using std::min;

namespace mozilla {
namespace image {

///////////////////////////////////////////////////////////////////////////////
// DecodePool implementation.
///////////////////////////////////////////////////////////////////////////////

/* static */ StaticRefPtr<DecodePool> DecodePool::sSingleton;
/* static */ uint32_t DecodePool::sNumCores = 0;

NS_IMPL_ISUPPORTS(DecodePool, nsIObserver)

struct Work
{
  enum class Type {
    TASK,
    SHUTDOWN
  } mType;

  RefPtr<IDecodingTask> mTask;
};

class DecodePoolImpl
{
public:
  MOZ_DECLARE_REFCOUNTED_TYPENAME(DecodePoolImpl)
  NS_INLINE_DECL_THREADSAFE_REFCOUNTING(DecodePoolImpl)

  DecodePoolImpl(uint8_t aMaxThreads,
                 uint8_t aMaxIdleThreads,
                 PRIntervalTime aIdleTimeout)
    : mMonitor("DecodePoolImpl")
    , mThreads(aMaxThreads)
    , mIdleTimeout(aIdleTimeout)
    , mMaxIdleThreads(aMaxIdleThreads)
    , mAvailableThreads(aMaxThreads)
    , mIdleThreads(0)
    , mShuttingDown(false)
  {
    MonitorAutoLock lock(mMonitor);
    bool success = CreateThread();
    MOZ_RELEASE_ASSERT(success, "Must create first image decoder thread!");
  }

  /// Shut down the provided decode pool thread.
  void ShutdownThread(nsIThread* aThisThread, bool aShutdownIdle)
  {
    {
      // If this is an idle thread shutdown, then we need to remove it from the
      // worker array. Process shutdown will move the entire array.
      MonitorAutoLock lock(mMonitor);
      if (!mShuttingDown) {
        ++mAvailableThreads;
        DebugOnly<bool> removed = mThreads.RemoveElement(aThisThread);
        MOZ_ASSERT(aShutdownIdle);
        MOZ_ASSERT(mAvailableThreads < mThreads.Capacity());
        MOZ_ASSERT(removed);
      }
    }

    // Threads have to be shut down from another thread, so we'll ask the
    // main thread to do it for us.
    SystemGroup::Dispatch(TaskCategory::Other,
                          NewRunnableMethod("DecodePoolImpl::ShutdownThread",
                                            aThisThread, &nsIThread::Shutdown));
  }

  /**
   * Requests shutdown. New work items will be dropped on the floor, and all
   * decode pool threads will be shut down once existing work items have been
   * processed.
   */
  void Shutdown()
  {
    nsTArray<nsCOMPtr<nsIThread>> threads;

    {
      MonitorAutoLock lock(mMonitor);
      mShuttingDown = true;
      mAvailableThreads = 0;
      threads.SwapElements(mThreads);
      mMonitor.NotifyAll();
    }

    for (uint32_t i = 0 ; i < threads.Length() ; ++i) {
      threads[i]->Shutdown();
    }
  }

  bool IsShuttingDown() const
  {
    MonitorAutoLock lock(mMonitor);
    return mShuttingDown;
  }

  /// Pushes a new decode work item.
  void PushWork(IDecodingTask* aTask)
  {
    MOZ_ASSERT(aTask);
    RefPtr<IDecodingTask> task(aTask);

    MonitorAutoLock lock(mMonitor);

    if (mShuttingDown) {
      // Drop any new work on the floor if we're shutting down.
      return;
    }

    if (task->Priority() == TaskPriority::eHigh) {
      mHighPriorityQueue.AppendElement(Move(task));
    } else {
      mLowPriorityQueue.AppendElement(Move(task));
    }

    // If there are pending tasks, create more workers if and only if we have
    // not exceeded the capacity, and any previously created workers are ready.
    if (mAvailableThreads) {
      size_t pending = mHighPriorityQueue.Length() + mLowPriorityQueue.Length();
      if (pending > mIdleThreads) {
        CreateThread();
      }
    }

    mMonitor.Notify();
  }

  Work StartWork(bool aShutdownIdle)
  {
    MonitorAutoLock lock(mMonitor);

    // The thread was already marked as idle when it was created. Once it gets
    // its first work item, it is assumed it is busy performing that work until
    // it blocks on the monitor once again.
    MOZ_ASSERT(mIdleThreads > 0);
    --mIdleThreads;
    return PopWorkLocked(aShutdownIdle);
  }

  Work PopWork(bool aShutdownIdle)
  {
    MonitorAutoLock lock(mMonitor);
    return PopWorkLocked(aShutdownIdle);
  }

private:
  /// Pops a new work item, blocking if necessary.
  Work PopWorkLocked(bool aShutdownIdle)
  {
    mMonitor.AssertCurrentThreadOwns();

    PRIntervalTime timeout = mIdleTimeout;
    do {
      if (!mHighPriorityQueue.IsEmpty()) {
        return PopWorkFromQueue(mHighPriorityQueue);
      }

      if (!mLowPriorityQueue.IsEmpty()) {
        return PopWorkFromQueue(mLowPriorityQueue);
      }

      if (mShuttingDown) {
        return CreateShutdownWork();
      }

      // Nothing to do; block until some work is available.
      if (!aShutdownIdle) {
        // This thread was created before we hit the idle thread maximum. It
        // will never shutdown until the process itself is torn down.
        ++mIdleThreads;
        MOZ_ASSERT(mIdleThreads <= mThreads.Capacity());
        mMonitor.Wait();
      } else {
        // This thread should shutdown if it is idle. If we have waited longer
        // than the timeout period without having done any work, then we should
        // shutdown the thread.
        if (timeout == 0) {
          return CreateShutdownWork();
        }

        ++mIdleThreads;
        MOZ_ASSERT(mIdleThreads <= mThreads.Capacity());

        PRIntervalTime now = PR_IntervalNow();
        mMonitor.Wait(timeout);
        PRIntervalTime delta = PR_IntervalNow() - now;
        if (delta > timeout) {
          timeout = 0;
        } else {
          timeout -= delta;
        }
      }

      MOZ_ASSERT(mIdleThreads > 0);
      --mIdleThreads;
    } while (true);
  }

  ~DecodePoolImpl() { }

  bool CreateThread();

  Work PopWorkFromQueue(nsTArray<RefPtr<IDecodingTask>>& aQueue)
  {
    Work work;
    work.mType = Work::Type::TASK;
    work.mTask = aQueue.PopLastElement();

    return work;
  }

  Work CreateShutdownWork() const
  {
    Work work;
    work.mType = Work::Type::SHUTDOWN;
    return work;
  }

  nsThreadPoolNaming mThreadNaming;

  // mMonitor guards everything below.
  mutable Monitor mMonitor;
  nsTArray<RefPtr<IDecodingTask>> mHighPriorityQueue;
  nsTArray<RefPtr<IDecodingTask>> mLowPriorityQueue;
  nsTArray<nsCOMPtr<nsIThread>> mThreads;
  PRIntervalTime mIdleTimeout;
  uint8_t mMaxIdleThreads;   // Maximum number of workers when idle.
  uint8_t mAvailableThreads; // How many new threads can be created.
  uint8_t mIdleThreads; // How many created threads are waiting.
  bool mShuttingDown;
};

class DecodePoolWorker final : public Runnable
{
public:
  explicit DecodePoolWorker(DecodePoolImpl* aImpl,
                            bool aShutdownIdle)
    : Runnable("image::DecodePoolWorker")
    , mImpl(aImpl)
    , mShutdownIdle(aShutdownIdle)
  { }

  NS_IMETHOD Run() override
  {
    MOZ_ASSERT(!NS_IsMainThread());

    nsCOMPtr<nsIThread> thisThread;
    nsThreadManager::get().GetCurrentThread(getter_AddRefs(thisThread));

    Work work = mImpl->StartWork(mShutdownIdle);
    do {
      switch (work.mType) {
        case Work::Type::TASK:
          work.mTask->Run();
          work.mTask = nullptr;
          break;

        case Work::Type::SHUTDOWN:
          mImpl->ShutdownThread(thisThread, mShutdownIdle);
          PROFILER_UNREGISTER_THREAD();
          return NS_OK;

        default:
          MOZ_ASSERT_UNREACHABLE("Unknown work type");
      }

      work = mImpl->PopWork(mShutdownIdle);
    } while (true);

    MOZ_ASSERT_UNREACHABLE("Exiting thread without Work::Type::SHUTDOWN");
    return NS_OK;
  }

private:
  RefPtr<DecodePoolImpl> mImpl;
  bool mShutdownIdle;
};

bool DecodePoolImpl::CreateThread()
{
  mMonitor.AssertCurrentThreadOwns();
  MOZ_ASSERT(mAvailableThreads > 0);

  bool shutdownIdle = mThreads.Length() >= mMaxIdleThreads;
  nsCOMPtr<nsIRunnable> worker = new DecodePoolWorker(this, shutdownIdle);
  nsCOMPtr<nsIThread> thread;
  nsresult rv = NS_NewNamedThread(mThreadNaming.GetNextThreadName("ImgDecoder"),
                                  getter_AddRefs(thread), worker,
                                  nsIThreadManager::kThreadPoolStackSize);
  if (NS_FAILED(rv) || !thread) {
    MOZ_ASSERT_UNREACHABLE("Should successfully create image decoding threads");
    return false;
  }

  mThreads.AppendElement(Move(thread));
  --mAvailableThreads;
  ++mIdleThreads;
  MOZ_ASSERT(mIdleThreads <= mThreads.Capacity());
  return true;
}

/* static */ void
DecodePool::Initialize()
{
  MOZ_ASSERT(NS_IsMainThread());
  sNumCores = max<int32_t>(PR_GetNumberOfProcessors(), 1);
  DecodePool::Singleton();
}

/* static */ DecodePool*
DecodePool::Singleton()
{
  if (!sSingleton) {
    MOZ_ASSERT(NS_IsMainThread());
    sSingleton = new DecodePool();
    ClearOnShutdown(&sSingleton);
  }

  return sSingleton;
}

/* static */ uint32_t
DecodePool::NumberOfCores()
{
  return sNumCores;
}

DecodePool::DecodePool()
  : mMutex("image::DecodePool")
{
  // Determine the number of threads we want.
  int32_t prefLimit = gfxPrefs::ImageMTDecodingLimit();
  uint32_t limit;
  if (prefLimit <= 0) {
    int32_t numCores = NumberOfCores();
    if (numCores <= 1) {
      limit = 1;
    } else if (numCores == 2) {
      // On an otherwise mostly idle system, having two image decoding threads
      // doubles decoding performance, so it's worth doing on dual-core devices,
      // even if under load we can't actually get that level of parallelism.
      limit = 2;
    } else {
      limit = numCores - 1;
    }
  } else {
    limit = static_cast<uint32_t>(prefLimit);
  }
  if (limit > 32) {
    limit = 32;
  }
  // The parent process where there are content processes doesn't need as many
  // threads for decoding images.
  if (limit > 4 && XRE_IsE10sParentProcess()) {
    limit = 4;
  }

  // The maximum number of idle threads allowed.
  uint32_t idleLimit;

  // The timeout period before shutting down idle threads.
  int32_t prefIdleTimeout = gfxPrefs::ImageMTDecodingIdleTimeout();
  PRIntervalTime idleTimeout;
  if (prefIdleTimeout <= 0) {
    idleTimeout = PR_INTERVAL_NO_TIMEOUT;
    idleLimit = limit;
  } else {
    idleTimeout = PR_MillisecondsToInterval(static_cast<uint32_t>(prefIdleTimeout));
    idleLimit = (limit + 1) / 2;
  }

  // Initialize the thread pool.
  mImpl = new DecodePoolImpl(limit, idleLimit, idleTimeout);

  // Initialize the I/O thread.
  nsresult rv = NS_NewNamedThread("ImageIO", getter_AddRefs(mIOThread));
  MOZ_RELEASE_ASSERT(NS_SUCCEEDED(rv) && mIOThread,
                     "Should successfully create image I/O thread");

  nsCOMPtr<nsIObserverService> obsSvc = services::GetObserverService();
  if (obsSvc) {
    obsSvc->AddObserver(this, "xpcom-shutdown-threads", false);
  }
}

DecodePool::~DecodePool()
{
  MOZ_ASSERT(NS_IsMainThread(), "Must shut down DecodePool on main thread!");
}

NS_IMETHODIMP
DecodePool::Observe(nsISupports*, const char* aTopic, const char16_t*)
{
  MOZ_ASSERT(strcmp(aTopic, "xpcom-shutdown-threads") == 0, "Unexpected topic");

  nsCOMPtr<nsIThread> ioThread;

  {
    MutexAutoLock lock(mMutex);
    ioThread.swap(mIOThread);
  }

  mImpl->Shutdown();

  if (ioThread) {
    ioThread->Shutdown();
  }

  return NS_OK;
}

bool
DecodePool::IsShuttingDown() const
{
  return mImpl->IsShuttingDown();
}

void
DecodePool::AsyncRun(IDecodingTask* aTask)
{
  MOZ_ASSERT(aTask);
  mImpl->PushWork(aTask);
}

bool
DecodePool::SyncRunIfPreferred(IDecodingTask* aTask, const nsCString& aURI)
{
  MOZ_ASSERT(NS_IsMainThread());
  MOZ_ASSERT(aTask);

  AUTO_PROFILER_LABEL_DYNAMIC_NSCSTRING(
    "DecodePool::SyncRunIfPreferred", GRAPHICS, aURI);

  if (aTask->ShouldPreferSyncRun()) {
    aTask->Run();
    return true;
  }

  AsyncRun(aTask);
  return false;
}

void
DecodePool::SyncRunIfPossible(IDecodingTask* aTask, const nsCString& aURI)
{
  MOZ_ASSERT(NS_IsMainThread());
  MOZ_ASSERT(aTask);

  AUTO_PROFILER_LABEL_DYNAMIC_NSCSTRING(
    "DecodePool::SyncRunIfPossible", GRAPHICS, aURI);

  aTask->Run();
}

already_AddRefed<nsIEventTarget>
DecodePool::GetIOEventTarget()
{
  MutexAutoLock threadPoolLock(mMutex);
  nsCOMPtr<nsIEventTarget> target = do_QueryInterface(mIOThread);
  return target.forget();
}

} // namespace image
} // namespace mozilla
