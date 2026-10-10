/**
 * The stamp feature's three pieces of the shell's markup: the layer a page click places the
 * armed picture through, the signature dialog, and the hidden file input behind "add an image".
 */

import type { Translator } from 'pdf-shared';
import { type StampPlacement, StampPlacementLayer, type StampPlacementLayerProps } from 'pdf-ui/tools';
import { lazy, Suspense } from 'react';
import { selectTool, useCore } from '../core/core-store';
import { imageInputRef, onImagePicked, placeSignature } from './stamp-actions';
import { closeSignatureDialog, forgetSavedSignature, useStamps } from './stamps-store';

// A dynamic chunk: the shell's first paint must not carry the dialogs (the entry budget is locked).
const SignatureDialog = lazy(async () => {
  const module = await import('pdf-ui/dialog');
  return { default: module.SignatureDialog };
});

/** The layer a click on a page places the armed picture with; nothing unless the stamp tool holds one. */
export function StampPlacementHost({
  viewer,
  canEdit,
  t,
  onPlace,
}: {
  readonly viewer: StampPlacementLayerProps['viewer'] | null;
  readonly canEdit: boolean;
  readonly t: Translator;
  readonly onPlace: (placement: StampPlacement) => void;
}) {
  const armed = useCore((state) => state.canvasTool === 'stamp');
  const source = useCore((state) => state.pendingStamp);
  if (viewer === null || !canEdit || !armed || source === null) return null;
  return (
    <StampPlacementLayer
      viewer={viewer}
      source={source}
      hint={t('sig.placing')}
      onPlace={onPlace}
      onCancel={() => selectTool('select')}
    />
  );
}

/**
 * The signature dialog while it is open. `canRemember` is `false` in a sensitive session,
 * which stores nothing, a signature picture included.
 */
export function SignatureDialogHost({
  t,
  canRemember,
}: {
  readonly t: Translator;
  readonly canRemember: boolean;
}) {
  const open = useStamps((state) => state.signatureOpen);
  const saved = useStamps((state) => state.savedSignatures);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <SignatureDialog
        t={t}
        saved={saved}
        canRemember={canRemember}
        onClose={closeSignatureDialog}
        onForget={forgetSavedSignature}
        onPlace={(source, remember) => placeSignature(source, remember, canRemember, t)}
      />
    </Suspense>
  );
}

/** The hidden file input the "add an image" command clicks; a chosen file is armed as the next stamp. */
export function ImagePickerInput({ t }: { readonly t: Translator }) {
  return (
    <input
      ref={imageInputRef}
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
      className="sr-only"
      tabIndex={-1}
      aria-hidden="true"
      onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (file !== undefined) void onImagePicked(file, t);
      }}
    />
  );
}
