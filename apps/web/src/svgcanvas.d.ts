/**
 * svgcanvas's package entry is a CommonJS build. Imported dynamically, esbuild
 * wraps it so only a default export survives and `{ Context }` comes back
 * undefined, so export.ts imports the ESM build the package also ships. It is
 * the same API that @types/svgcanvas describes for the package root.
 */
declare module 'svgcanvas/dist/svgcanvas.esm.js' {
  export * from 'svgcanvas';
}
