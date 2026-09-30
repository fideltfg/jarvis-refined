# Themes

A theme is a folder in this directory. Drop one in, restart the dev server, and
it is installed — nothing in `src/` has to change.

```text
public/themes/my-theme/
  theme.json     required — everything the character is, as data
  theme.css      optional — scoped under [data-theme='my-theme']
  persona.md     optional — the system prompt, as prose
  audio/         optional — cue and music recordings
```

Select it with `VITE_THEME=my-theme` in `.env.local`, or try it without editing
anything by loading `http://localhost:5173/?theme=my-theme`. The choice sticks
in that browser until another one is given.

The folder name is the id. Lowercase letters, digits, `-` and `_` only.

## theme.json

Every field is optional; what you leave out comes from the built-in defaults, so
a working theme.json can be two lines. Copy `stark/theme.json` and edit it —
that one sets everything, which makes it the best reference.

| Field | What it does |
|---|---|
| `name` | Human label for the theme. |
| `copy` | Every string the HUD shows: title, brand, per-phase status, rail titles, ignition button, the spoken audio-test line. |
| `backgroundColor` | Browser chrome colour (`meta[name=theme-color]`). |
| `phaseColors` | The accent for each phase: `offline`, `boot`, `dormant`, `waking`, `listening`, `thinking`, `tooling`, `speaking`. |
| `sceneTint` | Resting colours of the 3D reactor: `core`, `hot`, `particles`. |
| `wake.pattern` | JavaScript regex source matching the wake word **and its likely mishearings** — a speech recogniser will not spell your character's name the way you do. |
| `wake.phrases` | Spoken forms given to browsers that support phrase biasing. |
| `wake.language` | BCP-47 tag for speech recognition, e.g. `en-GB`. |
| `voice.kokoro` | Local neural voice id. See `VOICES` in `src/lib/kokoro.ts`. |
| `voice.character` | `british-male` or `computer` — which installed system voice to prefer when Kokoro is off. |
| `voice.profile` | Post-processing that gives the voice its box: speed, playback rate, filter band, presence lift, compression. |
| `sound.bank` | Which synthesised cue set to use: `stark`, `hal`, `wopr`, `mother`, `lcars`. |
| `sound.music` | Whether the theme has a score — the boot swell and the loop under a running tool. Off (the default) leaves the synthesised room tone as the only bed. |
| `sound.ambient` | The room tone: two oscillator frequencies, noise, lowpass cutoff and level. |
| `boot` | Which intro to play: `stark`, `hal`, `wopr`, `mother`, `lcars`. |
| `register` | `butler` or `machine` — which phrasebook the canned filler lines and agent announcements come from. |
| `suggestion` | One example command in the character's own idiom, for the idle hint. |
| `persona` | System prompt. `persona.md` wins if present. |
| `css` | Stylesheet filename, or `""` for none. Defaults to `theme.css`. |

`sound.bank` and `boot` name code that already exists, because a
synthesised cue and a boot animation are programs rather than data. An
unrecognised name falls back to the stock one, so a theme can never break the
app by asking for something that is not there.

## theme.css

Scope every rule under `[data-theme='<your-id>']` so nothing leaks if the
stylesheet is cached from a previous session. `src/index.css` is the baseline
underneath you — this file restyles the HUD rather than replacing it.

Web fonts are allowed from Google Fonts only; the page CSP pins it. Add an
`@import` at the top of the file, as the built-in themes do.

## persona.md

The character and its voice, in plain prose. Rules about length, register and
what it never says belong here. What it must not contain is instruction about
*tools* — that half is the same for every character and is appended
automatically by the bridge.

Both halves of the app read this file: the browser for the direct-API path, and
the bridge for the local-agent path, which is told the theme on connect. Editing
it and reloading the page is the whole edit-test loop.

## audio/

Cue recordings replace the synthesised ones. Name them after the cue: `boot`,
`wake`, `listen`, `tool`, `done`, `error`, `interrupt`, `ack`, `warning`,
`panel-open`, `panel-close`, `task-start`, `task-pause`, `task-done`,
`mic-open`, `mic-close`. Numbered
variants — `wake-1.mp3`, `wake-2.mp3` — rotate at random without an immediate
repeat, and must start at 1 with no gaps.

The three music cues use the same names as the shared ones: `boot-music.mp3`,
`ambient.mp3`, `work.mp3`.

Anything the theme does not carry falls through to `public/audio/`, and anything
missing from both is synthesised. Only ship recordings you have the right to
redistribute.
