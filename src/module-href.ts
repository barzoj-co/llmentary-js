/** ESM `import.meta.url`. The CJS emit of this file is overwritten with `__filename`. */
export function thisModuleHref(): string {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment -- CJS tsc rejects import.meta; ESM typecheck does not.
  // @ts-ignore CJS tsc (module: CommonJS) rejects import.meta; write-cjs-package replaces that emit.
  return import.meta.url;
}
