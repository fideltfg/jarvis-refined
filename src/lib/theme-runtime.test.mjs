import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, createLogger } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))
const project = fileURLToPath(new URL('../../', import.meta.url))
const themes = join(project, 'public/themes')

test('LCARS uses only its approved palette in styles, graphics and manifest', async () => {
  const palette = {
    blue: '#37a6d1',
    'bright-blue': '#41c4f7',
    'dark-blue': '#1c3c55',
    'dark-gray': '#2f3749',
    'ghost-gray': '#d2d5df',
    'light-gray': '#9ea5ba',
    'light-orange-red': '#ff6753',
    'medium-dark-blue': '#2a7193',
    'medium-dark-gray': '#52596e',
    'orange-red': '#e7442a',
    'pale-orange-red': '#ff977b',
    'primary-gray': '#6d748c',
    starlight: '#f3f4f7',
    black: '#000',
    white: '#fff',
  }
  const normalize = (color) => color.length === 4
    ? `#${[...color.slice(1)].map((digit) => digit + digit).join('')}`
    : color.toLowerCase()
  const allowed = new Set(Object.values(palette).map(normalize))
  const folder = join(themes, 'lcars')
  const css = await readFile(join(folder, 'theme.css'), 'utf8')
  for (const [name, color] of Object.entries(palette)) {
    assert.match(css, new RegExp(`--${name}:\\s*${color};`))
  }
  for (const file of (await readdir(folder)).filter((name) => /\.(css|tsx|json)$/.test(name))) {
    const source = await readFile(join(folder, file), 'utf8')
    for (const [color] of source.matchAll(/#[\da-f]{3,8}\b/gi)) {
      assert.ok(allowed.has(normalize(color)), `${file} uses an unapproved color: ${color}`)
    }
    assert.doesNotMatch(source, /color-mix\(|rgba?\(|hsla?\(/i, `${file} mixes colors outside the palette`)
  }
})

test('LCARS ultrawide layout separates diagnostics, session log and command windows', async () => {
  const css = await readFile(join(themes, 'lcars/theme.css'), 'utf8')
  const ultrawide = css.split('@media (min-width: 1800px) and (min-aspect-ratio: 21/9) {')[1]?.split('@media')[0]
  assert.ok(ultrawide, 'ultrawide styles must not affect standard desktop or mobile layouts')
  assert.match(ultrawide, /\.lcars-reactor-console \{[^}]*display: grid;[^}]*grid-template-columns: clamp\(360px, 20vw, 480px\) minmax\(0, 1fr\);[^}]*grid-template-rows: auto minmax\(0, 1fr\);/)
  assert.match(ultrawide, /\.lcars-reactor-grid \{[^}]*grid-template-columns: minmax\(0, 1fr\);[^}]*min-height: 0;[^}]*overflow-y: auto;/)
  assert.match(ultrawide, /\.lcars-control-deck \{[^}]*display: grid;[^}]*grid-template-columns: minmax\(0, 0\.9fr\) minmax\(0, 1\.1fr\);[^}]*grid-template-rows: auto auto auto minmax\(0, 1fr\) auto;[^}]*min-height: 0;/)
  assert.match(ultrawide, /\.lcars-deck-body \{\s*display: contents;/)
  assert.match(ultrawide, /\.lcars-deck-switches \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/)
  assert.match(ultrawide, /\.lcars-deck-operations \{[^}]*grid-column: 1;[^}]*grid-row: 2;/)
  assert.match(ultrawide, /\.lcars-deck-history \{\s*display: contents;/)
  assert.match(ultrawide, /\.lcars-deck-transcript \{[^}]*grid-column: 1;[^}]*grid-row: 4;/)
  const commandWindowStyles = css.split('@media (min-width: 1800px) and (min-aspect-ratio: 21/9) {')[2]?.split('@media')[0]
  assert.ok(commandWindowStyles)
  for (const panel of ['agent-board', 'command-palette-inline', 'timeline-inline', 'session-history-inline', 'task-scheduler-inline', 'file-browser-inline', 'diag', 'lcars-report-window', 'lcars-loose-window']) {
    assert.ok(commandWindowStyles.includes(`.${panel}`))
  }
  assert.match(commandWindowStyles, /position: relative;\s*grid-column: 2;\s*grid-row: 2 \/ -1;\s*inset: auto;/)
})

test('LCARS loose ends has command-window docking and a scrollable styled ledger', async () => {
  const css = await readFile(join(themes, 'lcars/theme.css'), 'utf8')
  const docking = css.match(/\.lcars-deck-history > :is\([^)]*\.lcars-loose-window[^)]*\) \{([^}]*)\}/)?.[1]
  assert.ok(docking)
  assert.match(docking, /position: absolute;/)
  assert.match(docking, /top: 40px;/)
  assert.match(docking, /bottom: 0;/)
  assert.match(css, /\.lcars-loose-window \{[^}]*display: flex;[^}]*border-left: var\(--lc-window-edge-width\) solid var\(--lc-window-edge\);/)
  assert.match(css, /\.lcars-loose-list \{[^}]*min-height: 0;[^}]*overflow-y: auto;[^}]*list-style: none;/)
  assert.match(css, /\.lcars-loose-row \{[^}]*display: grid;[^}]*minmax\(0, 1fr\)/)
})

test('LCARS status report keeps descriptions full-width and wraps metadata below them', async () => {
  const css = await readFile(join(themes, 'lcars/theme.css'), 'utf8')
  const row = css.match(/\.lcars-report-content li \{([^}]*)\}/)?.[1]
  const metadata = css.match(/\.lcars-report-content li small \{([^}]*)\}/)?.[1]
  assert.ok(row)
  assert.ok(metadata)
  assert.match(row, /display: block;/)
  assert.match(row, /overflow-wrap: anywhere;/)
  assert.match(metadata, /display: block;/)
  assert.match(metadata, /white-space: normal;/)
  assert.match(metadata, /overflow-wrap: anywhere;/)
  assert.doesNotMatch(metadata, /flex: 0 0 auto;|white-space: nowrap;/)
})

async function withTheme(manifest, module, check) {
  const folder = await mkdtemp(join(themes, 'test-theme-'))
  const id = basename(folder)
  const originals = new Map(['fetch', 'document', 'location', 'localStorage'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  let server
  try {
    await writeFile(join(folder, 'theme.json'), JSON.stringify(manifest))
    if (module) await writeFile(join(folder, 'theme.tsx'), module)
    await writeFile(join(folder, 'copy.ts'), 'export const label = "Folder-local intro"\n')
    await writeFile(join(folder, 'persona.md'), 'You are the folder-local assistant.')
    server = await createServer({
      root: project,
      cacheDir: join(folder, '.vite-cache'),
      define: {
        'import.meta.env.VITE_TTS_ENGINE': JSON.stringify('system'),
        'import.meta.env.VITE_USE_ELEVENLABS': JSON.stringify('true'),
        'import.meta.env.VITE_KOKORO_VOICE': JSON.stringify(''),
      },
      customLogger: createLogger('silent'),
      server: { host: '127.0.0.1', port: 0, https: false, watch: null },
      optimizeDeps: { noDiscovery: true, include: [] },
    })
    await server.listen()
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`
    const fetch = globalThis.fetch
    const sheets = []
    const saved = new Map()
    const document = {
      title: '',
      documentElement: { dataset: {} },
      querySelector: () => null,
      createElement: () => Object.assign(new EventTarget(), { dataset: {} }),
      head: { append: (link) => {
        sheets.push(link.href)
        queueMicrotask(() => link.dispatchEvent(new Event('load')))
      } },
    }
    Object.assign(globalThis, {
      fetch: (url, options) => fetch(new URL(url, origin), options),
      document,
      location: { search: `?theme=${id}` },
      localStorage: {
        setItem: (key, value) => saved.set(key, value),
        getItem: (key) => saved.get(key),
      },
    })
    const runtime = await server.ssrLoadModule('/src/lib/theme-runtime.ts')
    const active = await runtime.bootstrapTheme()
    await check({ runtime, active, id, sheets, document, saved, folder, server })
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
    await server?.close()
    await rm(folder, { recursive: true, force: true })
  }
}

test('a new folder supplies its own intro, reactor, HUD, frame, scene and sounds', async () => {
  await withTheme({ name: 'Folder Theme', id: 'ignored', css: 'local.css', bootDurationMs: 1234 }, `
    import { label } from './copy'
    export default {
      Boot: () => label,
      Reactor: () => 'local reactor',
      Hud: () => 'local HUD',
      Frame: () => 'local frame',
      Scene: () => 'local scene',
      sounds: ({ blip }) => ({ boot: () => blip(432) }),
    }
  `, async ({ runtime, active, id, sheets, document, saved }) => {
    assert.ok(runtime.themeIds().includes(id))
    assert.equal(active.id, id)
    assert.equal(active.bootDurationMs, 1234)
    assert.equal(active.persona, 'You are the folder-local assistant.')
    assert.equal(document.documentElement.dataset.theme, id)
    assert.equal(saved.get('jarvis.theme'), id)
    assert.deepEqual(sheets, [`/themes/${id}/local.css`])
    assert.equal(runtime.themeAsset('audio/wake.mp3'), `/themes/${id}/audio/wake.mp3`)
    const implementation = runtime.activeThemePackage()
    assert.equal(implementation.Boot(), 'Folder-local intro')
    assert.equal(implementation.Reactor(), 'local reactor')
    assert.equal(implementation.Hud(), 'local HUD')
    assert.equal(implementation.Frame(), 'local frame')
    assert.equal(implementation.Scene(), 'local scene')
    let frequency
    implementation.sounds({ blip: (value) => { frequency = value } }).boot()
    assert.equal(frequency, 432)
    assert.equal(await runtime.bootstrapTheme(), active)
  })
})

test('a manifest-only folder uses neutral defaults and can disable CSS', async () => {
  await withTheme({ name: 'Minimal', css: null, bootDurationMs: -1 }, null,
    ({ runtime, active, sheets }) => {
      assert.deepEqual(runtime.activeThemePackage(), {})
      assert.equal(active.bootDurationMs, 9200)
      assert.deepEqual(sheets, [])
      assert.equal(active.copy.brand, 'ASSISTANT')
    })
})

test('a broken theme module falls back without preventing bootstrap', async () => {
  await withTheme({ name: 'Broken', css: '' }, 'throw new Error("broken theme")\nexport default {}',
    ({ runtime, active }) => {
      assert.equal(active.name, 'Broken')
      assert.deepEqual(runtime.activeThemePackage(), {})
    })
})

test('a theme can select Kokoro despite global system speech and ElevenLabs settings', async () => {
  await withTheme({ name: 'Voice', css: '', voice: { engine: 'kokoro', kokoro: 'am_michael' } }, null,
    async ({ active, server }) => {
      const config = await server.ssrLoadModule('/src/config.ts')
      assert.equal(active.voice.engine, 'kokoro')
      assert.equal(config.TTS_ENGINE, 'kokoro')
      assert.equal(config.KOKORO_VOICE, 'am_michael')
      assert.equal(config.USE_ELEVENLABS, false)
    })
})

test('themes without a valid speech engine keep the global selection', async () => {
  for (const engine of [null, 'unsupported', { invalid: true }]) {
    await withTheme({ name: 'Voice defaults', css: '', voice: { engine } }, null,
      async ({ active, server }) => {
        const config = await server.ssrLoadModule('/src/config.ts')
        assert.equal(active.voice.engine, null)
        assert.equal(config.TTS_ENGINE, 'system')
        assert.equal(config.USE_ELEVENLABS, true)
      })
  }
})

test('installed themes keep their implementations and styles inside their folders', async () => {
  for (const entry of await readdir(themes, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const folder = join(themes, entry.name)
    const manifest = JSON.parse(await readFile(join(folder, 'theme.json'), 'utf8'))
    assert.equal('boot' in manifest, false, entry.name)
    assert.equal('bank' in manifest.sound, false, entry.name)
    await readFile(join(folder, 'theme.tsx'))
    await readFile(join(folder, 'Boot.tsx'))
    await readFile(join(folder, 'sounds.ts'))
    await readFile(join(folder, manifest.css))
  }
  const css = await readFile(join(root, 'index.css'), 'utf8')
  assert.doesNotMatch(css, /\.(?:hal-|wopr-|mother-|lcars-|orin-|boot-bar|boot-suit|boot-r-ring)/)
  for (const path of ['ui/ThemeBoot.tsx', 'ui/CharacterReactor.tsx', 'scene/Scene.tsx']) {
    assert.doesNotMatch(await readFile(join(root, path), 'utf8'), /['"](?:hal|wopr|mother|lcars|orin|stark)['"]/)
  }
  const hud = await readFile(join(root, 'ui/Hud.tsx'), 'utf8')
  assert.doesNotMatch(hud, /['"](?:hal|wopr|mother|orin|stark)['"]/)
  assert.match(hud, /activeTheme\(\)\.id === 'lcars'/)
})