# Grid TV: the game on a TV, the phone as its gamepad

`tv.html` draws the game with **Canvas 2D** (no WebGL) for screens that cannot run the full
renderer: a Chromecast, a smart TV's browser, an old laptop on the HDMI. `pad.html` turns a phone
into the gamepad. The full game (`index.html`) is unchanged.

```
 phone: pad.html                      TV: tv.html
 ┌──────────────────┐   controls      ┌───────────────────────────────┐
 │ lever, stick,    │ ──────────────► │ page: Canvas 2D renderer      │
 │ brake, fire,     │   30 / s        │   ▲ frames (what to draw)     │
 │ board, menu      │ ◄────────────── │ worker: the game (Simulation) │
 └──────────────────┘ profile, thr,   └───────────────────────────────┘
                      toasts, rumble
```

## Three ways to link the phone and the TV

| Link | Phone | TV | Needs |
| --- | --- | --- | --- |
| **Cast** | Chrome on Android (or a computer) | a Chromecast / Google TV runs `tv.html` as the receiver app | a registered Cast receiver app id (below) |
| **Relay code** | any phone, iPhones too | any browser showing `tv.html` | the Grid relay (`server/`, already deployed) |
| **This browser** | another tab or window | `tv.html` in the same browser | nothing (development, a laptop on the HDMI) |

Relay code, quickest to try: open `…/tv.html` on the big screen; it shows a four-letter code.
On the phone open `…/pad.html`, type the code, **Pair**. (`…/pad.html?code=ABCD` pairs at once.)

## Casting to a Chromecast

A Chromecast only runs web pages that are registered as a **Cast receiver app**. One-time setup:

1. Host the game over HTTPS (the GitHub Pages deploy does: `https://<user>.github.io/aerospace-program/`).
2. Register at the [Google Cast SDK Developer Console](https://cast.google.com/publish) (a
   one-time fee). **Add new application → Custom Receiver**; receiver URL:
   `https://<user>.github.io/aerospace-program/tv.html`. Note the **application id**.
3. While the app is unpublished it runs only on registered test devices: under **Cast Receiver
   Devices** add your Chromecast's serial number, then restart the Chromecast (it can take a few
   minutes to take effect). See Google's [registration guide](https://developers.google.com/cast/docs/registration).
4. Give the pad the id: either set the repository variable **`CAST_APP_ID`** (Settings → Secrets
   and variables → Actions → Variables) and re-run the Pages deploy, or open
   `…/pad.html?castApp=YOUR_ID` once on the phone (it is remembered).
5. On the phone (Chrome on Android), open `…/pad.html`, tap **Cast to a TV**, pick the
   Chromecast. The TV loads `tv.html`; the phone that started the cast is the gamepad.

`tv.html` knows it is on a Cast device (`CrKey` in the user agent; `?cast` forces it) and then
starts the Cast Web Receiver with the custom channel `urn:x-cast:com.shelbeeely.aerospace.pad`,
no media players and no idle timeout. iPhones cannot start a cast from a web page: pair by code.

## Who runs the game

- **The TV (default).** The game runs in a Web Worker on the TV, so simulating and drawing use
  two cores. On a Cast device the world is thinned (`lite`: fewer aircraft, no tower turrets).
- **The phone.** Tick *Run the game on this phone* (or `pad.html?host=1`): the phone simulates
  and sends the TV about 15 frames a second (each ~4-6 KB); the TV only draws, still planning
  the city itself from the seed. For a receiver too slow to keep the game at real time. Works
  over Cast and within one browser; the relay carries controls only (4 KB a message).

Rough numbers from a desktop: the game uses about a fifth of one core; drawing takes 2-4 ms a
frame at 720p. A Chromecast's cores are several times slower, so a first-generation or 3rd-gen
Chromecast will likely need the phone to run the game; a Chromecast with Google TV / Google TV
Streamer may keep up on its own. The drawing adapts (range, facets, ground detail) to hold its
frame rate; `?stats` shows the timings, including the game's real-time ratio.

## What the TV view draws

A small software 3D pipeline in Canvas 2D (`src/tv/TvRenderer.ts`): a chase camera, near-plane
clipping, back faces dropped, whole convex pieces sorted far to near. In the 1982 language:
dark masses shaded by orientation, light only where it means something (structure top rims, a
craft's light parts, light walls, the street grid and data highways, lit spire tips), distance
haze and the amber horizon band under a deep sky; distant tall structures as hazy silhouettes.

Drawn: every structure piece (the architecture's masses, kit towers, the airport), standing
blocks of broken structures, the player's craft from its parts, road traffic and jetwalls,
light walls and ribbons, aircraft, the Bits (their real figures near, diamonds far), street
programs, tower turrets, shots, explosions and blasts, craters; the HUD for the vehicle's
profile, toasts and a heading-up radar. Not drawn (yet): the Outlands landforms (the ground is
flat), the sea, the weather, falling rubble, runway markings, sound.

## Pad controls

The pad is the game's own touch controls (`TouchDevice`), laid out per vehicle by
`src/hud/profiles.ts`: lever (power, lift or cruise) on the left, stick on the right, brake,
FIRE / DROP when armed, YES / NO and BOARD on foot. The ☰ menu has what a gamepad's other
buttons do: next / previous vehicle, camera (chase, far, overhead), Navigator hold, light trail,
weapons, on foot / board, flaps, radar range, trim reset, strategic, new vehicle, reset world,
help on the TV. The TV's own keyboard and gamepad work too (the game's usual keys).

## Files

- `src/tv/protocol.ts`: the messages, their checks, the input packer; `src/tv/pair.ts`: codes.
- `src/tv/format.ts`: the frame format; `src/tv/frame.ts`: frames from a Simulation.
- `src/tv/host.ts`: the game as the TV plays it; `src/tv/host.worker.ts`: it in a worker.
- `src/tv/structures.ts`, `src/tv/plan.ts`: the architecture packed for drawing, and rebuilt
  from a chunk list when the phone runs the game.
- `src/tv/TvRenderer.ts`, `src/tv/main.ts`, `tv.html`: the TV. `src/pad/main.ts`, `pad.html`: the pad.
- `src/tv/links.ts`: Cast sender / receiver, relay, BroadcastChannel. `server/pads.ts`: pairing.
- `src/input/RemoteDevice.ts`: the phone's controls as an input device.
- Checks: `npm run tv`, `npm run test:server`.
