import { bindings, defineConfig, triggers } from 'cf/config';

const productionSupabaseRef = 'tfrfkvkjmaqnpxdhxumr';

export default defineConfig(({ isPreview }) => {
  const requestedPreviewRef = isPreview ? process.env.MEMBERSHIP_PREVIEW_SUPABASE_REF : undefined;
  const previewRef = requestedPreviewRef && /^[a-z0-9]{20}$/.test(requestedPreviewRef) &&
    requestedPreviewRef !== productionSupabaseRef ? requestedPreviewRef : undefined;
  const launch = (name: string) => bindings.text(!isPreview || previewRef ? process.env[name] ?? 'disabled' : 'disabled');
  return {
  accountId: '70884be24a5775303f80ffdcafc4eb6c',
  worker: {
    name: 'cpwebsite',
    domains: ['cpvaluemart.com', 'www.cpvaluemart.com'],
    workersDev: true,
    previewUrls: true,
    triggers: isPreview ? [] : [triggers.scheduled({ schedule: '* * * * *' })],
    entrypoint: './src/worker.mjs',
    compatibilityDate: '2026-11-17',
    env: { ASSETS: bindings.assets(),
      SUPABASE_URL: bindings.text('https://' + (previewRef ?? productionSupabaseRef) + '.supabase.co'),
      MEMBERSHIP_PREVIEW_SUPABASE_REF: bindings.text(previewRef ?? 'disabled'),
      SUPABASE_PUBLISHABLE_KEY: bindings.secret(),
      SUPABASE_SECRET_KEY: bindings.secret(),
      STRIPE_CHECKOUT_MODE: bindings.text(isPreview ? 'sandbox' : 'live-pilot'),
      MEMBERSHIP_LAUNCH_AT: launch('MEMBERSHIP_LAUNCH_AT'),
      MEMBERSHIP_TIERS_LAUNCH_AT: launch('MEMBERSHIP_TIERS_LAUNCH_AT'),
      PAID_MEMBERSHIP_LAUNCH_AT: launch('PAID_MEMBERSHIP_LAUNCH_AT'),
      STRIPE_SECRET_KEY: bindings.secret(),
      STRIPE_WEBHOOK_SECRET: bindings.secret(),
      RESEND_API_KEY: bindings.secret(),
      RESEND_WEBHOOK_SECRET: bindings.secret(),
      TRANSACTIONAL_EMAIL_TEST_RECIPIENTS: bindings.secret(),
      TRANSACTIONAL_EMAIL_FROM: bindings.text('CP Value Mart <orders@notify.cpvaluemart.com>'),
      TRANSACTIONAL_EMAIL_REPLY_TO: bindings.text('orders@notify.cpvaluemart.com')
    },
    assets: { runWorkerFirst: ['/api', '/api/*', '/auth/confirm', '/auth/reset'], notFoundHandling: '404-page' },
    observability: { enabled: true, redactQueryString: true,
      logs: { enabled: true, invocationLogs: false }, traces: { enabled: false } }
  }
  };
});
