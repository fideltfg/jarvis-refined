# Troubleshooting

## Microphone or Wake Phrase

- Use Chrome or Edge in a normal browser window, not an embedded preview.
- Click **INITIALISE** and grant microphone permission.
- Check the browser's site permissions if the microphone was previously denied.
- Press **D** for live input/output diagnostics. Press **T** to run the audio
  self-test.
- Confirm the selected theme's wake phrase in [Themes](themes.md). Press
  **Space** to speak without the wake phrase.

## No Spoken Reply

- Confirm the browser audio is not muted and the session was initialized by a
  user click.
- Kokoro may need to download its model on first use. Try
  `VITE_TTS_ENGINE=system` if WebGPU or model loading is unavailable.
- Use **D** to see whether a response was produced and whether playback started.

## Bridge or Provider Unavailable

- In separate-process mode, make sure `npm run bridge` is still running.
- Check that port `8787` is available, or align `JARVIS_BRIDGE_PORT` and
  `VITE_BRIDGE_URL` if you changed it.
- Confirm the selected provider is configured on the bridge. Claude requires a
  Claude Code login; OpenAI requires `OPENAI_API_KEY`; Local requires both its
  endpoint URL and model. See [Configuration](configuration.md).
- If a browser origin was changed, allow it explicitly with
  `JARVIS_ALLOWED_ORIGINS`.

## Theme or Hand Tracking

- Environment changes such as `VITE_THEME` require restarting the dev server.
- Hand tracking is off by default. Press **G** and allow camera access; confirm
  `npm start` has copied the MediaPipe runtime into `public/mediapipe`.

## Background Agents

- The agent service must be running on its configured port, and the bridge must
  have both `JARVIS_AGENTS=1` and the matching `JARVIS_AGENTS_TOKEN`.
- The service refuses to start without a token. Generate one with
  `npm run agents:token` and load the same secrets file into both processes.
- The agent service binds to loopback; it is not a remote or LAN service.
