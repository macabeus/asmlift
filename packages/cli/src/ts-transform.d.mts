// Types for `ts-transform.mjs`, which is JavaScript because it loads beside tsx.
import type { TransformOptions } from 'esbuild';

export declare const transformOptions: (path: string) => TransformOptions;
export declare function tsxTsconfigPath(env?: NodeJS.ProcessEnv, cwd?: string): string | undefined;
export declare function parseJsonc(text: string): unknown;
export declare function tsconfigStandDown(path: string | undefined): string | undefined;
export declare function compileForHook(source: string, path: string): string | undefined;
