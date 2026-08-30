import { defineConfig } from 'tsdown';
const PLUGIN_ID = 'dsh-sql-formatter';
const PLATFORM_MODULES = ['react', 'react-dom', '@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-settings'];
export default defineConfig([
  { entry: { index: 'src/index.ts' }, outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2022', external: [/^@deepseek-ai\//, /^node:/], dts: true, clean: true, tsconfig: 'tsconfig.json' },
  { entry: { client: 'src/client/index.ts' }, outDir: 'lib', format: 'cjs', platform: 'browser', external: [...PLATFORM_MODULES], noExternal: (id) => !PLATFORM_MODULES.some(m => id === m || id.startsWith(m + '/')), outputOptions: { entryFileNames: 'client.js', banner: `window.__ModuleLoader__.load({ id: "${PLUGIN_ID}", factory: (require) => {`, footer: 'return module.exports; } });', intro: 'var module = { exports: {} }; var exports = module.exports;' }, tsconfig: 'tsconfig.json' },
]);
