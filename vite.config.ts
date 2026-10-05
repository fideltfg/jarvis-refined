import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Publish the list of installed themes at /themes/index.json.
 *
 * A theme is a folder in public/themes containing a theme.json, and the point
 * of the design is that dropping one in is all it takes. The browser cannot
 * list a directory, so the list has to be produced here: scanned per request in
 * dev, so a folder added while the server is running appears on the next
 * reload, and emitted into the bundle at build time.
 */
function themeIndex(): Plugin {
  const dir = resolve(fileURLToPath(new URL('.', import.meta.url)), 'public/themes')
  const scan = () =>
    existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && existsSync(resolve(dir, entry.name, 'theme.json')))
          .map((entry) => entry.name)
      : []

  return {
    name: 'jarvis-theme-index',
    configureServer(server) {
      server.middlewares.use('/themes/index.json', (_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify(scan()))
      })
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'themes/index.json', source: JSON.stringify(scan()) })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), themeIndex()],
  worker: { format: 'es' },
  server: {
    // Honour PORT so a second instance can run alongside the first. The bridge
    // only accepts sockets from localhost:5173-5199, so stay inside that range
    // or set JARVIS_ALLOWED_ORIGINS to match.
    port: Number(process.env.PORT) || 5173,
    // JARVIS_HOST=0.0.0.0 serves the face on the LAN as well as localhost.
    host: process.env.JARVIS_HOST || undefined,
    // JARVIS_TLS_CERT and JARVIS_TLS_KEY (PEM paths) serve the face over HTTPS,
    // which browsers require for the microphone on anything but localhost.
    https:
      process.env.JARVIS_TLS_CERT && process.env.JARVIS_TLS_KEY
        ? {
            cert: readFileSync(process.env.JARVIS_TLS_CERT),
            key: readFileSync(process.env.JARVIS_TLS_KEY),
          }
        : undefined,
    // An HTTPS page may not open ws:// or fetch http://, so the bridge is also
    // reachable same-origin at /bridge (VITE_BRIDGE_URL=wss://host:5173/bridge)
    // and one certificate covers both halves.
    proxy: {
      '/bridge': {
        target: `http://127.0.0.1:${process.env.JARVIS_BRIDGE_PORT ?? 8787}`,
        ws: true,
        // The bridge picks which machine's browser to drive by who is asking.
        xfwd: true,
        rewrite: (path) => path.replace(/^\/bridge/, '') || '/',
      },
    },
  },
  optimizeDeps: {
    // kokoro-js pulls in `phonemizer`, which carries espeak-ng as inline WASM.
    // Vite's dependency pre-bundler rewrites that initialisation and the
    // language table ends up empty — the symptom is
    // `Invalid language identifier: "en". Should be one of: .` at generate()
    // time, long after the model has loaded successfully. Serving these
    // untouched fixes it.
    exclude: ['kokoro-js', 'phonemizer', '@huggingface/transformers'],
  },
})
