/**
 * Encryption and unlocking.
 *
 * The two directions of the same engine capability, and the two result kinds that
 * keep them apart: protecting **replaces** the working document (the user asked
 * for this file to be protected), unlocking opens the decrypted document **beside**
 * it — the protected original is still what the user has on disk, and losing it to
 * an in-place replace would be the one mistake this capability must not make.
 *
 * Nothing here re-implements the policy: an empty open password is refused by
 * `protectDocument` (`error.password-policy` says why), the produced bytes are
 * re-opened and their permissions checked inside the operation, and a wrong unlock password raises `wrong-password` rather than a raw
 * engine string.
 */

import { type ProtectionPermissions, partFileName, protectDocument, unlockDocument } from 'pdf-core';
import type { OperationDialogSpec } from '../dialogs/types';

/**
 * Encrypt with an open password, an owner password and a permission set.
 *
 * The eight permissions `ProtectionPermissions` carries are all granted by
 * default (`ALL_PERMISSIONS`): a user unchecks what to forbid, and the dialog
 * never has to explain a permission that is missing from the UI.
 */
export const protectDialog: OperationDialogSpec = {
  id: 'protect',
  titleKey: 'security.title',
  introKey: 'security.intro',
  confirmKey: 'op.apply',
  // The encrypted copy is a file to hand over, not a new version of the open document: a
  // protected file is read-only in the editor, so applying it ended in a password prompt
  // for the document the user was still editing.
  resultKind: 'download',
  fields: [
    {
      id: 'oldPassword',
      kind: 'password',
      labelKey: 'security.oldPassword',
      hintKey: 'security.oldPasswordHint',
    },
    {
      id: 'userPassword',
      kind: 'password',
      labelKey: 'security.openPassword',
      hintKey: 'security.userPasswordHint',
    },
    {
      id: 'ownerPassword',
      kind: 'password',
      labelKey: 'security.ownerPassword',
      hintKey: 'security.ownerPasswordHint',
    },
    {
      id: 'permissions',
      kind: 'checkboxList',
      labelKey: 'security.permissions',
      hintKey: 'security.permissionsHint',
      defaultValue: [
        'print',
        'printHighQuality',
        'copy',
        'modify',
        'annotate',
        'form',
        'assemble',
        'accessibility',
      ],
      options: [
        { value: 'print', labelKey: 'security.permission.print' },
        { value: 'printHighQuality', labelKey: 'security.permission.printHq' },
        { value: 'copy', labelKey: 'security.permission.copy' },
        { value: 'modify', labelKey: 'security.permission.modify' },
        { value: 'annotate', labelKey: 'security.permission.annotate' },
        { value: 'form', labelKey: 'security.permission.form' },
        { value: 'assemble', labelKey: 'security.permission.assemble' },
        { value: 'accessibility', labelKey: 'security.permission.accessibility' },
      ],
    },
  ],
  run: async (params, context) => {
    // Membership, not a table: which boxes are ticked is exactly what the checked
    // list holds, and the eight permission names are the operation's own key names.
    const granted = new Set(
      Array.isArray(params.permissions) ? (params.permissions as readonly string[]) : [],
    );
    const permissions: ProtectionPermissions = {
      print: granted.has('print'),
      printHighQuality: granted.has('printHighQuality'),
      copy: granted.has('copy'),
      modify: granted.has('modify'),
      annotate: granted.has('annotate'),
      form: granted.has('form'),
      assemble: granted.has('assemble'),
      accessibility: granted.has('accessibility'),
    };

    const outcome = await protectDocument(
      context.bytes,
      {
        // Not trimmed: a password's spaces are part of the password.
        userPassword: String(params.userPassword ?? ''),
        ownerPassword: String(params.ownerPassword ?? ''),
        permissions,
        // The credential the incoming document carries, when it is locked.
        oldPassword: String(params.oldPassword ?? ''),
      },
      { signal: context.signal, onProgress: context.onProgress },
    );

    return {
      files: [{ name: context.name, bytes: outcome.bytes, mime: 'application/pdf' }],
      report: outcome.report,
      noticeKey: 'security.done',
    };
  },
};

/**
 * Remove the password.
 *
 * The password field is the whole dialog: everything else is a promise the user
 * needs before typing a secret into it, and that promise is the intro — the
 * password is used for this run, not stored.
 */
export const unlockDialog: OperationDialogSpec = {
  id: 'unlock',
  titleKey: 'security.unlock.title',
  introKey: 'security.unlock.intro',
  confirmKey: 'op.result.newTab',
  resultKind: 'new-tab',
  fields: [
    {
      id: 'password',
      kind: 'password',
      labelKey: 'security.unlock.password',
      hintKey: 'security.unlock.passwordHint',
    },
  ],
  run: async (params, context) => {
    const outcome = await unlockDocument(context.bytes, String(params.password ?? ''), {
      signal: context.signal,
      onProgress: context.onProgress,
    });

    // Named after the document it came from, so the decrypted copy can sit beside
    // the protected one without either name lying about which is which.
    const name = partFileName(context.name, 0, 1, `-${context.t('security.unlock.suffix')}`);

    return {
      files: [{ name, bytes: outcome.bytes, mime: 'application/pdf' }],
      report: outcome.report,
    };
  },
};
