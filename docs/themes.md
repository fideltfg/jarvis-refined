# Themes

Themes change the assistant's character and the entire browser presentation:
palette, typography, wake phrase, persona, voice profile, audio, boot sequence,
and live animation. Built-in themes are stored in `public/themes/`:

| ID | Character | Wake phrase |
|---|---|---|
| `stark` | Cyan holographic JARVIS HUD | “Hey Jarvis” |
| `hal` | Red optical-computer console | “Hal” |
| `wopr` | Amber military CRT command grid | “Joshua” |
| `mother` | Green industrial mainframe terminal | “Mother” |
| `lcars` | LCARS-style computer display | “Computer” |
| `orin` | Amber operational reasoning console | “ORIN” |

Set `VITE_THEME` in `.env.local` and restart the dev server to change the
default. To preview another theme for the current browser, use a URL such as
`http://localhost:5173/?theme=hal`. The browser remembers the URL selection.

## Controls

| Input | Action |
|---|---|
| Theme wake phrase | Wake JARVIS. |
| **Space** | Speak without the wake phrase. |
| **K** | Toggle push-to-talk mode. |
| Hold **Right Alt** | Talk while held when push-to-talk is enabled. |
| **Shift+K** | Bind push-to-talk to another key or mouse button. |
| Speak while JARVIS is talking | Interrupt speech (barge-in). |
| **V** | Cycle the browser voice. |
| **Escape** | Stand down. |
| **D** | Open live diagnostics. |
| **T** | Run the audio self-test. |
| **G** | Toggle optional hand tracking and camera access. |

## Audio

Interface cues use local Web Audio synthesis unless a theme supplies a
recording. Theme recordings fall back to shared assets in `public/audio/`; music
uses the same theme-then-shared lookup. Task cues require the background-agent
connection. Use only audio you have rights to redistribute; franchise recordings
may be copyrighted even when they are easy to download.

For the theme folder layout, `theme.json` fields, scoped CSS, persona files, cue
names, and asset fallback rules, see the dedicated
[theme package authoring reference](../public/themes/README.md).
