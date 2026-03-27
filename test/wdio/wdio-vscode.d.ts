/**
 * Type augmentations for wdio-vscode-service.
 *
 * The wdio-vscode-service adds `executeWorkbench()` and other methods to the
 * WebdriverIO `browser` object at runtime. These declarations allow TypeScript
 * to recognize them without full type resolution of the ESM @wdio/globals package.
 */

declare module '@wdio/globals' {
  export const browser: any
  export const expect: any
  export const $: any
  export const $$: any
}
