/**
 * `Promise.withResolvers` for this slice.
 *
 * The repository's TypeScript `lib` is ES2023 (`tsconfig.json`) while both
 * runtimes we ship to have the method — Chromium ≥ 119 and Node 26 (ES2024).
 * The printing slice needs it for `canvas.toBlob()`, whose completion is a
 * callback: the alternative is the `new Promise((resolve, reject) => …)`
 * executor form, which the repository's rules keep out of product code. The
 * declaration is local to this folder rather than a shared compiler change,
 * exactly as archived spike `**` does it.
 */
interface PromiseConstructor {
  withResolvers<T>(): {
    readonly promise: Promise<T>;
    readonly resolve: (value: T | PromiseLike<T>) => void;
    readonly reject: (reason?: unknown) => void;
  };
}
