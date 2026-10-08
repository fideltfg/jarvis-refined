# Audio credits

These tracks are by **Kevin MacLeod** (incompetech.com), licensed
**Creative Commons Attribution 4.0**. Free to use commercially — including in a
monetised YouTube video — provided the attribution below appears somewhere the
audience can see it (a description box is fine).

| File | Track | Used for |
|---|---|---|
| `boot-music.mp3` | *Impact Prelude* | The swell when the reactor comes up |
| `work.mp3` | *Mechanolith* | Rises while a tool is running |

`ambient.mp3` (the low bed looping under the interface, *Ossuary 6 – Air* by the
same artist and licence) is not currently bundled in this folder; this theme's
`sound.music` is on, so until that file is added, the music-bed loop stays
silent instead of falling back to the synthesised room tone. Add it here, named
`ambient.mp3`, to enable it; see [Audio](../../../../docs/themes.md#audio).

## Attribution to paste into a video description

```
Music by Kevin MacLeod (incompetech.com)
  "Impact Prelude"    — Licensed under Creative Commons: By Attribution 4.0
  "Mechanolith"       — Licensed under Creative Commons: By Attribution 4.0
http://creativecommons.org/licenses/by/4.0/
```

Add the "Ossuary 6 - Air" line back to the attribution block above if you add
`ambient.mp3`.

## Why not the actual Iron Man score

Disney/Marvel run one of the most aggressive Content ID operations on YouTube.
Real film score or JARVIS dialogue in an upload means a near-certain claim,
demonetisation, or a strike — on a video whose whole point is to be seen. These
tracks are in the same register and cost you a line of text instead.

## Replacing them

Drop in any MP3 with the same filename and it takes over — nothing in the code
references the track names. Other sources worth a look: incompetech.com (same
licence), Pixabay Music (CC0, no attribution at all), and the YouTube Audio
Library.

The short interface sounds — wake pips, tool ticks, the completion chime — are
not files. They're synthesised in Web Audio in `src/lib/sfx.ts`, so there's
nothing to download and nothing to credit. Drop `wake.mp3`, `listen.mp3`,
`tool.mp3`, `done.mp3` or `error.mp3` in here to override any of them.

Theme-specific overrides use subdirectories such as `hal/`, `wopr/` and
`mother/`. Add `boot.mp3` alongside the other cue names to replace a
theme's synthesized startup. Do not commit recordings unless their licence
permits redistribution; being downloadable from a fan archive is not itself a
reuse licence.
