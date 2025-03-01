/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Tests if source editors are lazily initialized.
 */

async function ifWebGLSupported() {
  let { target, panel } = await initShaderEditor(SIMPLE_CANVAS_URL);
  let { gFront, ShadersEditorsView } = panel.panelWin;

  reload(target);
  await once(gFront, "program-linked");

  let vsEditor = await ShadersEditorsView._getEditor("vs");
  let fsEditor = await ShadersEditorsView._getEditor("fs");

  ok(vsEditor, "A vertex shader editor was initialized.");
  ok(fsEditor, "A fragment shader editor was initialized.");

  isnot(vsEditor, fsEditor,
    "The vertex shader editor is distinct from the fragment shader editor.");

  let vsEditor2 = await ShadersEditorsView._getEditor("vs");
  let fsEditor2 = await ShadersEditorsView._getEditor("fs");

  is(vsEditor, vsEditor2,
    "The vertex shader editor instances are cached.");
  is(fsEditor, fsEditor2,
    "The fragment shader editor instances are cached.");

  await teardown(panel);
  finish();
}
