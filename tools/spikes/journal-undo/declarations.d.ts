/**
 * Spike-local declarations (throwaway, `PLAN.md §9/K21`).
 *
 * 1. `pdfjs-dist/build/pdf.mjs?raw` — Vite's `?raw` query inlines the *installed*
 *    engine source as a string, which is how item 5 of this spike checks the
 *    CommandManager cap against the file the running engine came from instead of
 *    quoting documentation.
 * 2. `Promise.withResolvers` — the repository's TypeScript `lib` is ES2023 while
 *    the runtime (Chromium ≥ 119) and Node 26 both ship it; IndexedDB's request
 *    events need the resolvers, so the declaration is added here rather than
 *    relaxing a shared compiler option from inside a spike.
 */
declare module 'pdfjs-dist/build/pdf.mjs?raw' {
  const source: string;
  export default source;
}

declare global {
  interface PromiseConstructor {
    withResolvers<T>(): {
      readonly promise: Promise<T>;
      readonly resolve: (value: T | PromiseLike<T>) => void;
      readonly reject: (reason?: unknown) => void;
    };
  }
}

export {};
