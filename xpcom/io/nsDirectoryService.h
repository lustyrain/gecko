/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ts=8 sts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef nsDirectoryService_h___
#define nsDirectoryService_h___

#include "nsIDirectoryService.h"
#include "nsInterfaceHashtable.h"
#include "nsIFile.h"
#include "nsAtom.h"
#include "nsDirectoryServiceDefs.h"
#include "nsStaticAtom.h"
#include "nsTArray.h"
#include "mozilla/Attributes.h"
#include "mozilla/StaticPtr.h"

#define NS_XPCOM_INIT_CURRENT_PROCESS_DIR       "MozBinD"   // Can be used to set NS_XPCOM_CURRENT_PROCESS_DIR
                                                            // CANNOT be used to GET a location
#define NS_DIRECTORY_SERVICE_CID  {0xf00152d0,0xb40b,0x11d3,{0x8c, 0x9c, 0x00, 0x00, 0x64, 0x65, 0x73, 0x74}}

namespace mozilla {
namespace detail {

struct DirectoryAtoms
{
  #define DIR_ATOM(name_, value_) NS_STATIC_ATOM_DECL_STRING(name_, value_)
  #include "nsDirectoryServiceAtomList.h"
  #undef DIR_ATOM

  enum class Atoms {
    #define DIR_ATOM(name_, value_) NS_STATIC_ATOM_ENUM(name_)
    #include "nsDirectoryServiceAtomList.h"
    #undef DIR_ATOM
    AtomsCount
  };

  const nsStaticAtom mAtoms[static_cast<size_t>(Atoms::AtomsCount)];
};

extern const DirectoryAtoms gDirectoryAtoms;

} // namespace detail
} // namespace mozilla

class nsDirectoryService final
  : public nsIDirectoryService
  , public nsIProperties
  , public nsIDirectoryServiceProvider2
{
public:
  NS_DECL_THREADSAFE_ISUPPORTS

  NS_DECL_NSIPROPERTIES

  NS_DECL_NSIDIRECTORYSERVICE

  NS_DECL_NSIDIRECTORYSERVICEPROVIDER

  NS_DECL_NSIDIRECTORYSERVICEPROVIDER2

  nsDirectoryService();

  static void RealInit();
  void RegisterCategoryProviders();

  static nsresult
  Create(nsISupports* aOuter, REFNSIID aIID, void** aResult);

  static mozilla::StaticRefPtr<nsDirectoryService> gService;

private:
  ~nsDirectoryService();

  nsresult GetCurrentProcessDirectory(nsIFile** aFile);

  nsInterfaceHashtable<nsCStringHashKey, nsIFile> mHashtable;
  nsTArray<nsCOMPtr<nsIDirectoryServiceProvider>> mProviders;

  static const nsStaticAtom* const sAtoms;
  static constexpr size_t sAtomsLen =
    mozilla::ArrayLength(mozilla::detail::gDirectoryAtoms.mAtoms);

public:
  #define DIR_ATOM(name_, value_) NS_STATIC_ATOM_DECL_PTR(nsStaticAtom, name_)
  #include "nsDirectoryServiceAtomList.h"
  #undef DIR_ATOM
};

#endif
