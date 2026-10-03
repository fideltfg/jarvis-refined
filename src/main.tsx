import './index.css'
import { bootstrapTheme } from './lib/theme-runtime'
import { startPerformanceCleanup } from './lib/performance'

if (import.meta.env.DEV) {
  const stopPerformanceCleanup = startPerformanceCleanup()
  import.meta.hot?.dispose(stopPerformanceCleanup)
}

/**
 * Resolve the theme, then start.
 *
 * The order is the whole design. Themes are folders under public/themes/ that
 * are discovered over the network, so the manifest cannot be known until a
 * fetch has landed — but the rest of the app reads its words, colours, wake
 * word and voice as module-level constants. Importing App before the manifest
 * exists would freeze the defaults in place.
 *
 * So nothing that touches a theme is imported statically here. The dynamic
 * import below is the barrier: every module behind it evaluates after the
 * manifest is in hand, which is what lets the rest of the codebase stay free of
 * theme plumbing.
 *
 * Deliberately no StrictMode inside: its double-invoked effects would open the
 * microphone and arm the wake-word engine twice, and the second subscription
 * steals the audio stream from the first.
 */
bootstrapTheme()
  .then(() => import('./boot.tsx'))
  .catch((error: unknown) => {
    console.error('[jarvis] theme failed to load', error)
    const root = document.getElementById('root')
    if (root) {
      root.textContent =
        'No theme could be loaded. Check that public/themes contains at least one folder with a theme.json, then restart.'
      root.setAttribute('style', 'padding:2rem;font:14px system-ui;color:#9fb')
    }
  })

