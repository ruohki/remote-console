# remote-console web UI

Vite + React 19 + TypeScript + Tailwind 4 single-page app, embedded into the `remote-console`
binary from `dist/` at build time. Contract: `../API.md`; wire types: `src/protocol/` (generated).

```sh
npm install
npm run dev            # http://localhost:5173, proxies /api, /ws, /install.* to :8080
npm run build          # -> dist/ (the Rust server embeds this)
npm run typecheck      # tsc --noEmit
npm run lint           # eslint
npm test               # vitest
npm run sync-protocol  # regenerate src/protocol from ../../remote-agent/crates/protocol
```

Set `CONSOLE_DEV_BACKEND` to proxy the dev server somewhere other than `http://localhost:8080`.

## Layout

```
src/lib        api client, /ws/ui socket, WebRTC helpers (codec preference, stats),
               viewer geometry + input mapping (pure, unit tested), formatting, theme, toasts
src/store      zustand live state (devices/sessions from the socket), auth context
src/hooks      useViewerSession (signaling + RTCPeerConnection + data channels), useNow
src/components UI primitives, layout, badges, error boundary, add-device dialog
src/pages      setup, login, devices, device detail, viewer, sessions, users, audit, settings, 404
src/protocol   ts-rs output — do not edit by hand
```

## Viewer notes

* The browser is the WebRTC offerer. It puts every `video/H265` receive codec first via
  `setCodecPreferences`, then H.264; the agent encodes whatever is negotiated.
* The offer is created before `session_offer` is sent, but `setLocalDescription` (which starts
  ICE gathering) only runs after `session_created` delivers the session's STUN/TURN servers.
* Mouse coordinates are mapped to the remote display's physical pixels through
  `toRemotePixels` (object-fit: contain aware). Keys are sent as `KeyboardEvent.code`.
* `Ctrl+Shift+Esc` releases the keyboard from the viewer; blur/visibility change sends `rel`.
