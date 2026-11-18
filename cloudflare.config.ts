import { bindings, defineConfig } from 'cf/config';

export default defineConfig({
  accountId: '70884be24a5775303f80ffdcafc4eb6c',
  worker: {
    name: 'cpwebsite',
    domains: ['cpvaluemart.com', 'www.cpvaluemart.com'],
    workersDev: true,
    previewUrls: true,
    entrypoint: './src/worker.mjs',
    compatibilityDate: '2026-11-17',
    env: { ASSETS: bindings.assets() },
    assets: { runWorkerFirst: ['/api', '/api/*'], notFoundHandling: '404-page' },
    observability: { enabled: true, redactQueryString: true,
      logs: { enabled: true, invocationLogs: false }, traces: { enabled: false } }
  }
});
