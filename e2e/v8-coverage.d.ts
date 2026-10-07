/** The part of `@bcoe/v8-coverage` (which ships no types) the e2e coverage fixture uses. */
declare module '@bcoe/v8-coverage' {
  export interface RangeCov {
    readonly startOffset: number;
    readonly endOffset: number;
    readonly count: number;
  }
  export interface FunctionCov {
    readonly functionName: string;
    readonly ranges: readonly RangeCov[];
    readonly isBlockCoverage: boolean;
  }
  export interface ScriptCov {
    readonly scriptId: string;
    readonly url: string;
    readonly functions: readonly FunctionCov[];
  }
  export interface ProcessCov {
    readonly result: readonly ScriptCov[];
  }
  export function mergeProcessCovs(processCovs: readonly ProcessCov[]): ProcessCov;
}
