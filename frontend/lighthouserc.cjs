/**
 * Lighthouse CI configuration for ai-net frontend.
 *
 * Enforced gates (CI must pass):
 *   - Performance:   >= 80
 *   - Accessibility: >= 95
 *
 * Budgets (informational / tracked):
 *   - SEO: >= 80
 *
 * Routes tested:
 *   - /        (Landing page — primary entry point)
 *   - /agents  (Agent registry browser — public browsing page)
 */

module.exports = {
  ci: {
    collect: {
      // Use production build served via vite preview.
      startServerCommand: 'npx vite preview --host 0.0.0.0 --port 4173',
      startServerReadyPattern: 'Local:',
      url: [
        'http://localhost:4173/',
        'http://localhost:4173/agents',
      ],
      numberOfRuns: 2,
      // Chromium flags for headless CI environments.
      settings: {
        chromeFlags: '--no-sandbox --disable-gpu --disable-dev-shm-usage',
      },
    },
    assert: {
      assertions: {
        // ── Hard gates ────────────────────────────────────────────────
        'categories:performance': ['error', { minScore: 0.80 }],
        'categories:accessibility': ['error', { minScore: 0.95 }],

        // ── SEO budget ────────────────────────────────────────────────
        'categories:seo': ['warn', { minScore: 0.80 }],

        // ── Best practices (informational) ────────────────────────────
        'categories:best-practices': ['warn', { minScore: 0.70 }],

        // ── Resource budget hints ─────────────────────────────────────
        'resource-summary:script:size': ['warn', { maxNumericValue: 500000 }],
        'resource-summary:total:size': ['warn', { maxNumericValue: 3000000 }],
      },
    },
    upload: {
      // Use temporary LHCI storage — results are publicly viewable for 7 days.
      target: 'temporary-public-storage',
    },
    server: {
      // Port used by vite preview during CI collection.
      port: 4173,
    },
  },
}
