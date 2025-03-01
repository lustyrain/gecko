/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_TextEditor_h
#define mozilla_TextEditor_h

#include "mozilla/EditorBase.h"
#include "nsCOMPtr.h"
#include "nsCycleCollectionParticipant.h"
#include "nsIEditor.h"
#include "nsIEditorMailSupport.h"
#include "nsIPlaintextEditor.h"
#include "nsISupportsImpl.h"
#include "nscore.h"

class nsIContent;
class nsIDOMDocument;
class nsIDOMEvent;
class nsIDocumentEncoder;
class nsIOutputStream;
class nsISelectionController;
class nsITransferable;

namespace mozilla {

class AutoEditInitRulesTrigger;
class HTMLEditRules;
enum class EditAction : int32_t;

namespace dom {
class DragEvent;
class Selection;
} // namespace dom

/**
 * The text editor implementation.
 * Use to edit text document represented as a DOM tree.
 */
class TextEditor : public EditorBase
                 , public nsIPlaintextEditor
                 , public nsIEditorMailSupport
{
public:
  NS_DECL_ISUPPORTS_INHERITED
  NS_DECL_CYCLE_COLLECTION_CLASS_INHERITED(TextEditor, EditorBase)

  enum ETypingAction
  {
    eTypedText,  /* user typed text */
    eTypedBR,    /* user typed shift-enter to get a br */
    eTypedBreak  /* user typed enter */
  };

  TextEditor();

  // nsIPlaintextEditor methods
  NS_DECL_NSIPLAINTEXTEDITOR

  // nsIEditorMailSupport overrides
  NS_DECL_NSIEDITORMAILSUPPORT

  // Overrides of EditorBase
  virtual nsresult RemoveAttributeOrEquivalent(
                     Element* aElement,
                     nsAtom* aAttribute,
                     bool aSuppressTransaction) override;
  virtual nsresult SetAttributeOrEquivalent(Element* aElement,
                                            nsAtom* aAttribute,
                                            const nsAString& aValue,
                                            bool aSuppressTransaction) override;
  using EditorBase::RemoveAttributeOrEquivalent;
  using EditorBase::SetAttributeOrEquivalent;

  virtual nsresult Init(nsIDocument& aDoc, Element* aRoot,
                        nsISelectionController* aSelCon, uint32_t aFlags,
                        const nsAString& aValue) override;

  nsresult DocumentIsEmpty(bool* aIsEmpty);
  NS_IMETHOD GetDocumentIsEmpty(bool* aDocumentIsEmpty) override;

  NS_IMETHOD DeleteSelection(EDirection aAction,
                             EStripWrappers aStripWrappers) override;

  NS_IMETHOD SetDocumentCharacterSet(const nsACString& characterSet) override;

  // If there are some good name to create non-virtual Undo()/Redo() methods,
  // we should create them and those methods should just run them.
  NS_IMETHOD Undo(uint32_t aCount) final;
  NS_IMETHOD Redo(uint32_t aCount) final;

  NS_IMETHOD Cut() override;
  NS_IMETHOD CanCut(bool* aCanCut) override;
  NS_IMETHOD Copy() override;
  NS_IMETHOD CanCopy(bool* aCanCopy) override;
  NS_IMETHOD CanDelete(bool* aCanDelete) override;
  NS_IMETHOD Paste(int32_t aSelectionType) override;
  NS_IMETHOD CanPaste(int32_t aSelectionType, bool* aCanPaste) override;
  NS_IMETHOD PasteTransferable(nsITransferable* aTransferable) override;
  NS_IMETHOD CanPasteTransferable(nsITransferable* aTransferable,
                                  bool* aCanPaste) override;

  NS_IMETHOD OutputToString(const nsAString& aFormatType,
                            uint32_t aFlags,
                            nsAString& aOutputString) override;

  NS_IMETHOD OutputToStream(nsIOutputStream* aOutputStream,
                            const nsAString& aFormatType,
                            const nsACString& aCharsetOverride,
                            uint32_t aFlags) override;

  /**
   * All editor operations which alter the doc should be prefaced
   * with a call to StartOperation, naming the action and direction.
   */
  NS_IMETHOD StartOperation(EditAction opID,
                            nsIEditor::EDirection aDirection) override;

  /**
   * All editor operations which alter the doc should be followed
   * with a call to EndOperation.
   */
  NS_IMETHOD EndOperation() override;

  /**
   * Make the given selection span the entire document.
   */
  virtual nsresult SelectEntireDocument(Selection* aSelection) override;

  virtual nsresult HandleKeyPressEvent(
                     WidgetKeyboardEvent* aKeyboardEvent) override;

  virtual dom::EventTarget* GetDOMEventTarget() override;

  virtual nsresult BeginIMEComposition(WidgetCompositionEvent* aEvent) override;
  virtual nsresult UpdateIMEComposition(
                     WidgetCompositionEvent* aCompositionChangeEvet) override;

  virtual already_AddRefed<nsIContent> GetInputEventTargetContent() override;

  // Utility Routines, not part of public API
  NS_IMETHOD TypedText(const nsAString& aString, ETypingAction aAction);

  nsresult InsertTextAt(const nsAString& aStringToInsert,
                        nsINode* aDestinationNode,
                        int32_t aDestOffset,
                        bool aDoDeleteSelection);

  virtual nsresult InsertFromDataTransfer(dom::DataTransfer* aDataTransfer,
                                          int32_t aIndex,
                                          nsIDOMDocument* aSourceDoc,
                                          nsINode* aDestinationNode,
                                          int32_t aDestOffset,
                                          bool aDoDeleteSelection) override;

  virtual nsresult InsertFromDrop(dom::DragEvent* aDropEvent) override;

  /**
   * Extends the selection for given deletion operation
   * If done, also update aAction to what's actually left to do after the
   * extension.
   */
  nsresult ExtendSelectionForDelete(Selection* aSelection,
                                    nsIEditor::EDirection* aAction);

  /**
   * Return true if the data is safe to insert as the source and destination
   * principals match, or we are in a editor context where this doesn't matter.
   * Otherwise, the data must be sanitized first.
   */
  bool IsSafeToInsertData(nsIDOMDocument* aSourceDoc);

  static void GetDefaultEditorPrefs(int32_t& aNewLineHandling,
                                    int32_t& aCaretStyle);

  /**
    * The maximum number of characters allowed.
    *   default: -1 (unlimited).
    */
  int32_t MaxTextLength() const { return mMaxTextLength; }
  void SetMaxTextLength(int32_t aLength) { mMaxTextLength = aLength; }

  /**
   * Replace existed string with a string.
   * This is fast path to replace all string when using single line control.
   *
   * @ param aString   the string to be set
   */
  nsresult SetText(const nsAString& aString);

protected:
  virtual ~TextEditor();

  NS_IMETHOD InitRules();
  void BeginEditorInit();
  nsresult EndEditorInit();

  already_AddRefed<nsIDocumentEncoder> GetAndInitDocEncoder(
                                         const nsAString& aFormatType,
                                         uint32_t aFlags,
                                         const nsACString& aCharset);

  /**
   * CreateBR() creates new <br> element and inserts it before aPointToInsert,
   * and collapse selection if it's necessary.
   *
   * @param aPointToInsert  The point to insert new <br> element.
   * @param aSelect         If eNone, this won't change selection.
   *                        If eNext, selection will be collapsed after the
   *                        <br> element.
   *                        If ePrevious, selection will be collapsed at the
   *                        <br> element.
   * @return                The new <br> node.  If failed to create new <br>
   *                        node, returns nullptr.
   */
  template<typename PT, typename CT>
  already_AddRefed<Element>
  CreateBR(const EditorDOMPointBase<PT, CT>& aPointToInsert,
           EDirection aSelect = eNone);

  /**
   * CreateBRImpl() creates a <br> element and inserts it before aPointToInsert.
   * Then, tries to collapse selection at or after the new <br> node if
   * aSelect is not eNone.
   * XXX Perhaps, this should be merged with CreateBR().
   *
   * @param aSelection          The selection of this editor.
   * @param aPointToInsert      The DOM point where should be <br> node inserted
   *                            before.
   * @param aSelect             If eNone, this won't change selection.
   *                            If eNext, selection will be collapsed after
   *                            the <br> element.
   *                            If ePrevious, selection will be collapsed at
   *                            the <br> element.
   * @return                    The new <br> node.  If failed to create new
   *                            <br> node, returns nullptr.
   */
  template<typename PT, typename CT>
  already_AddRefed<Element>
  CreateBRImpl(Selection& aSelection,
               const EditorDOMPointBase<PT, CT>& aPointToInsert,
               EDirection aSelect);

  /**
   * Factored methods for handling insertion of data from transferables
   * (drag&drop or clipboard).
   */
  NS_IMETHOD PrepareTransferable(nsITransferable** transferable);
  nsresult InsertTextFromTransferable(nsITransferable* transferable);

  /**
   * Shared outputstring; returns whether selection is collapsed and resulting
   * string.
   */
  nsresult SharedOutputString(uint32_t aFlags, bool* aIsCollapsed,
                              nsAString& aResult);

  enum PasswordFieldAllowed
  {
    ePasswordFieldAllowed,
    ePasswordFieldNotAllowed
  };
  bool CanCutOrCopy(PasswordFieldAllowed aPasswordFieldAllowed);
  bool FireClipboardEvent(EventMessage aEventMessage,
                          int32_t aSelectionType,
                          bool* aActionTaken = nullptr);

  bool UpdateMetaCharset(nsIDocument& aDocument,
                         const nsACString& aCharacterSet);

protected:
  nsCOMPtr<nsIDocumentEncoder> mCachedDocumentEncoder;
  nsString mCachedDocumentEncoderType;
  int32_t mWrapColumn;
  int32_t mMaxTextLength;
  int32_t mInitTriggerCounter;
  int32_t mNewlineHandling;
  int32_t mCaretStyle;

  friend class AutoEditInitRulesTrigger;
  friend class HTMLEditRules;
  friend class TextEditRules;
};

} // namespace mozilla

mozilla::TextEditor*
nsIEditor::AsTextEditor()
{
  return static_cast<mozilla::TextEditor*>(this);
}

const mozilla::TextEditor*
nsIEditor::AsTextEditor() const
{
  return static_cast<const mozilla::TextEditor*>(this);
}

#endif // #ifndef mozilla_TextEditor_h
