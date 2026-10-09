import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parse } from 'smol-toml'
import { loadSettingsFile, settingsToEnv } from '../bridge/settings.mjs'
import { parseEnv, split } from './migrate-config.mjs'

// Confirms the checked-in example parses without unknown-setting warnings.
test('config.example.toml parses and every active key is recognised', () => {
  const { env, warnings } = settingsToEnv(parse(readFileSync('config.example.toml', 'utf8')))
  assert.deepEqual(warnings, [])
  assert.equal(env.VITE_THEME, 'stark')
})

// Checks frontend settings retain their expected serialized environment forms.
test('mcp_servers and model settings reach the frontend env as JSON/strings', () => {
  const { env } = settingsToEnv(parse('[frontend]\nmodel = "claude-sonnet-5"\nfast_mode = false\n[[frontend.mcp_servers]]\nname = "docs"\nurl = "https://x.test/mcp"\ntoken_env = "VITE_DOCS_TOKEN"\n'))
  assert.equal(env.VITE_MODEL, 'claude-sonnet-5')
  assert.equal(env.VITE_FAST_MODE, 'false')
  assert.deepEqual(JSON.parse(env.VITE_MCP_SERVERS), [{ name: 'docs', url: 'https://x.test/mcp', token_env: 'VITE_DOCS_TOKEN' }])
})

// Distinguishes path-valued *_KEY settings from actual credential names.
test('path settings ending in key stay in config while credentials go to secrets', () => {
  const { config, secrets } = split(parseEnv('JARVIS_TLS_KEY=/k.pem\nJARVIS_AGENTS_PORT=8788\nJARVIS_AGENTS_TOKEN=t'))
  assert.deepEqual(config, { bridge: { tls_key: '/k.pem', agents_port: 8788 } })
  assert.deepEqual(secrets, [['JARVIS_AGENTS_TOKEN', 't']])
})

// Verifies frontend and bridge sections map to their runtime environment keys.
test('config.toml maps sections to environment variables', () => {
  const { env, warnings } = settingsToEnv({
    frontend: { theme: 'lcars', use_elevenlabs: false },
    bridge: { agents: true, auto_compact_window: 150000, allowed_origins: ['https://a', 'https://b'], endpoints: [{ id: 'x' }] },
  })
  assert.deepEqual(warnings, [])
  assert.equal(env.VITE_THEME, 'lcars')
  assert.equal(env.VITE_USE_ELEVENLABS, 'false')
  assert.equal(env.JARVIS_AGENTS, '1')
  assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '150000')
  assert.equal(env.JARVIS_ALLOWED_ORIGINS, 'https://a,https://b')
  assert.equal(env.JARVIS_ENDPOINTS, '[{"id":"x"}]')
})

// Confirms untrusted or unsupported config entries are warned about and omitted.
test('credentials and unknown keys in config.toml are rejected and never become env', () => {
  const { env, warnings } = settingsToEnv({
    frontend: { anthropic_api_key: 'sk-x', bogus: 1 },
    bridge: { relay_token: 't' },
    other: { a: 1 },
  })
  assert.deepEqual(env, {})
  assert.equal(warnings.length, 4)
  assert.match(warnings.join('\n'), /looks like a credential/)
})

// Checks precedence and the optional-file behavior of settings loading.
test('loadSettingsFile does not override existing variables and tolerates a missing file', () => {
  const env = { VITE_THEME: 'hal' }
  const text = '[frontend]\ntheme = "lcars"\ntts_engine = "system"\n'
  assert.equal(loadSettingsFile('c.toml', { env, readFile: () => text }), true)
  assert.equal(env.VITE_THEME, 'hal')
  assert.equal(env.VITE_TTS_ENGINE, 'system')
  // Simulate a missing file so the optional-load path can be exercised directly.
  const missing = () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }) }
  assert.equal(loadSettingsFile('none.toml', { env, readFile: missing }), false)
})

// Verifies the migrator separates recognized settings from secret/unknown names.
test('migration sends credentials and unknown names to secrets and the rest to config', () => {
  const { config, secrets } = split(parseEnv([
    'VITE_THEME=lcars', 'JARVIS_AGENTS=1', 'OPENAI_API_KEY=sk-test', 'JARVIS_LOCAL_API_KEY=k',
    'CLAUDE_CODE_AUTO_COMPACT_WINDOW=150000', 'JARVIS_ALLOWED_ORIGINS=https://a, https://b', 'CUSTOM_THING=1', '# VITE_THEME=stark',
  ].join('\n')))
  assert.deepEqual(config, {
    frontend: { theme: 'lcars' },
    bridge: { agents: true, auto_compact_window: 150000, allowed_origins: ['https://a', 'https://b'] },
  })
  assert.deepEqual(secrets.map(([name]) => {
    // Compare secret names without exposing or asserting their values.
    return name
  }), ['OPENAI_API_KEY', 'JARVIS_LOCAL_API_KEY', 'CUSTOM_THING'])
})
