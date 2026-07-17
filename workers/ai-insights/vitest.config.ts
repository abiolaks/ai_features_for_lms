import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: {
          configPath: './wrangler.test.jsonc',
        },
        miniflare: {
          compatibilityDate: '2024-12-30',
        },
      },
    },
  },
});
