/**
 * The File System Access entry points this app calls.
 *
 * `lib.dom` declares `FileSystemFileHandle` and `createWritable()` (checked with
 * TypeScript 6.0) but **not** the picker functions — they come from the WICG File
 * System Access spec, which is not part of the DOM standard yet. This file declares
 * exactly the surface the shell uses, so a browser or type change that drops one of
 * these fails `tsc` instead of failing at runtime.
 *
 * The shell never assumes these exist: when they are missing (Firefox, Safari) the
 * Open button falls back to a file input and Save is disabled in favour of Export —
 * the documented browser-support contract, not a defect.
 */

interface FilePickerAcceptType {
  readonly description?: string;
  readonly accept: Record<string, readonly string[]>;
}

interface OpenFilePickerOptions {
  readonly types?: readonly FilePickerAcceptType[];
  readonly excludeAcceptAllOption?: boolean;
  readonly multiple?: boolean;
  readonly id?: string;
}

declare function showOpenFilePicker(options?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>;

/**
 * Permission on a handle kept across sessions (`recent-handles.ts`). Declared optional: the
 * methods are WICG, not DOM, and a browser that lacks them is treated as having granted the
 * read the user just picked.
 */
interface FileSystemHandlePermissionDescriptor {
  readonly mode?: 'read' | 'readwrite';
}

interface FileSystemHandle {
  queryPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  requestPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}

/** A dropped file's handle (Chromium): what lets a dropped document be saved in place. */
interface DataTransferItem {
  getAsFileSystemHandle?(): Promise<FileSystemHandle | null>;
}
