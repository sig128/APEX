# The 30-second ad: "Read the line."

A vertical spot (1080×1920, 30 s at 30 fps). The picture is drawn on a canvas and rendered
frame by frame. The soundtrack is synthesized in Python and timed to the same moments as the
picture. The players and numbers in it are made up, and no real sportsbook appears.

| File | What it does |
| --- | --- |
| `ad.html` | The film. `window.renderAt(t)` draws one moment. `window.renderFrame(f, S)` draws frame `f` as `S` moments averaged over a half-frame shutter, which gives the motion blur. |
| `stills.py 1.0 8.0 22.0` | Saves PNG stills of the moments you name, plus a contact sheet, for review. |
| `render.py` | Renders all 900 frames into `frames/` with two headless Chromium workers (about 4 minutes). `render.py 4 2 830 900` re-renders frames 830 to 899 only. |
| `audio.py` | Writes `audio.wav` (48 kHz stereo, 120 BPM in F minor), mastered to −14 LUFS and −1.3 dBTP. |

## Build the video

```sh
python3 render.py
python3 audio.py
ffmpeg -framerate 30 -i frames/f%05d.png -i audio.wav \
  -vf "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p" \
  -c:v libx264 -preset slow -crf 17 -profile:v high \
  -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv \
  -c:a aac -b:a 256k -ar 48000 -movflags +faststart propify-ad.mp4
```

You need Python 3 with Playwright (Chromium), numpy, scipy and Pillow, plus ffmpeg.

## Changing it

- Timing lives in `ad.html`. The big hits are listed in `IMPACTS`. If you move a hit, move
  the same moment in `audio.py`, since the soundtrack places each sound at a fixed time.
- The end card's small print reads "21+. Please bet responsibly.", "Gambling problem? Call
  1-800-MY-RESET." and "Propify is a research tool, not a sportsbook." Check the rules for
  the state or platform you run it in, which may require a different helpline or wording.
- Fonts: Big Shoulders Display and Barlow, both under the SIL Open Font License.
