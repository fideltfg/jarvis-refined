import { readdirSync, existsSync } from 'node:fs'
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
  server: {
    // Honour PORT so a second instance can run alongside the first. The bridge
    // only accepts sockets from localhost:5173-5199, so stay inside that range
    // or set JARVIS_ALLOWED_ORIGINS to match.
    port: Number(process.env.PORT) || 5173,
    // JARVIS_HOST=0.0.0.0 serves the face on the LAN as well as localhost.
    host: process.env.JARVIS_HOST || undefined,
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
