// Ambient module shims for non-code imports bundled by esbuild.
// Leaflet ships a stylesheet we import for its side effects; esbuild emits it
// to renderer/dist/app.css. tsc only needs to know the module exists.
declare module '*.css';
