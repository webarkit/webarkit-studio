# Creative tools: markers and models for WebAR

Authoring a WebAR scene needs two kinds of assets: **marker images that track well** and **3D
models**. Blender, ComfyUI and Krita expose MCP servers that an agent can drive. This page sets
them up and describes a pipeline from an image to a graph in the studio (#10):

```
image (ComfyUI, Krita, or npm run example:marker)
  → NFT dataset (NFT generator: .iset, .fset, .fset3)
  → trackability check (npm run trackability)
  → glTF model (Blender, or the default cube)
  → project file with the graph (npm run example:project) → Import… in the studio
```

Everything here is **optional and local**:

- No creative tool is a dependency of this repository, and none is in the shared `.mcp.json`.
  Register the servers in your own scope (for example `claude mcp add --scope user`).
- Generated assets are not committed. The example writes them to `generated/`, which git ignores.
- Record the **provenance and licence** of every asset you keep. The licence of a tool does not
  usually cover what you make with it, but the licence of the **model weights** you generate with
  can restrict how you use the output (some diffusion models are non-commercial). Note the tool, the
  model and its licence, the prompt or seed, and the date, as `example:marker` does in
  `<name>.provenance.json`.

## Tool status

Checked on 2026-11-03, against each project's repository, release page or package index. These
projects move fast, so check them again before you rely on a version.

| Tool | Server | Version | Licence | Notes |
|---|---|---|---|---|
| Blender | [Blender Lab MCP server](https://www.blender.org/lab/mcp-server/) (official, [source](https://projects.blender.org/lab/blender_mcp)) | 1.0.3 (2026-09-11) | GPL-3.0-or-later | Blender 5.1 or newer. A Blender add-on plus a stdio server (`blender-mcp`, Python ≥ 3.10) that talks to it over TCP, `localhost:9876` by default. |
| Blender | [MCP for Blender](https://github.com/ahujasid/blender-mcp) (community, formerly `blender-mcp`) | no releases | MIT | Not affiliated with the Blender Foundation: a separate project with its own add-on and tools. Running both at once can clash on the add-on port, so pick one. |
| ComfyUI | [Comfy MCP](https://github.com/Comfy-Org/comfy-mcp) (official, local) | 0.10.0 (2026-08-10), beta | AGPL-3.0-or-later or commercial | stdio. Python ≥ 3.10 and [comfy-cli](https://github.com/Comfy-Org/comfy-cli) ≥ 1.14.0 (1.25.0 today), with a ComfyUI workspace. |
| ComfyUI | Comfy Cloud MCP (official, hosted) | n/a | service terms | Remote HTTP at `https://cloud.comfy.org/mcp`, runs on Comfy Cloud GPUs. Needs a Comfy Cloud account. |
| Krita | [krita-mcp](https://github.com/thuanlm215/krita-mcp) (community) | 1.8.1 (2026-10-16) | CC0-1.0 (server and plugin); GPL-2.0-or-later (optional native helper) | No official server exists. Krita 5.2+ for documents, layers and export. Drawing, filters and Undo need Linux, Krita 6.0.4 and the native helper. |
| Krita | [krita-codex-mcp](https://github.com/cyyprezz/krita-codex-mcp) (community) | 0.2.2 (2026-10-22) | MIT | Windows-first, written for OpenAI Codex. |
| NFT generator | [NFT-Marker-Creator-App](https://github.com/webarkit/NFT-Marker-Creator-App) | npm 0.4.0, PyPI `nft-marker-creator` 0.1.0 | LGPL-3.0 | Not an MCP server. Writes the `.iset`, `.fset` and `.fset3` of a dataset from a JPEG or PNG. |

The Blender Lab page warns that the server runs LLM-generated code in Blender **without any
guards**. Use it on a machine without sensitive data, or in a virtual machine.

## Setup

The commands below are for Claude Code. Other MCP clients take the same command and arguments in
their own configuration file.

### Blender (official server)

1. Install the add-on in Blender 5.1 or newer, following the
   [Blender Lab page](https://www.blender.org/lab/mcp-server/). Either drag it into Blender twice
   (once to add the Blender Lab repository, once to install it), or download `mcp-1.0.3.zip` and use
   *Install from Disk*. The add-on starts its server when Blender opens, unless you turn auto-start
   off in its preferences.
2. Get the server and register it. It runs with [uv](https://docs.astral.sh/uv/):

   ```bash
   git clone https://projects.blender.org/lab/blender_mcp.git
   claude mcp add --scope user blender -- uv --directory /absolute/path/to/blender_mcp/mcp run blender-mcp
   ```

   Clients that read `.mcpb` bundles can install `blender-1.0.3.mcpb` from the
   [release page](https://projects.blender.org/lab/blender_mcp/releases) instead.

### ComfyUI (local server)

```bash
pip install comfy-mcp "comfy-cli>=1.14.0"
comfy install          # a ComfyUI workspace, if you have none
claude mcp add --scope user comfy-mcp -e COMFY_BIN=/path/to/venv/bin/comfy -- comfy-mcp
```

Start ComfyUI before you use the tools. The server runs `comfy` for every call. For the hosted
server, run `claude mcp add --scope user --transport http comfy-cloud https://cloud.comfy.org/mcp`
instead.

### Krita (community server)

```bash
uvx krita-mcp install      # close Krita first: it writes kritarc
uvx krita-mcp --selftest
claude mcp add --scope user krita -- uvx krita-mcp
```

Then enable **MCP Bridge** under *Settings → Configure Krita → Python Plugin Manager* if the
installer has not.

### NFT generator

Either the Python package or the Node app:

```bash
pip install nft-marker-creator
nft-marker-creator -i marker.jpg -o generated --threads 4
```

If `pip` or `nft-marker-creator` is not found (on Windows, Python's `Scripts` folder is often not
on the `PATH`), go through Python instead:

```bash
python -m pip install nft-marker-creator
python -c "import nft_marker_creator as nmc; print(nmc.create('marker.jpg', output_dir='generated', threads=4))"
```

Or clone the Node app, run `npm install`, then `cd src` and `node NFTMarkerCreator.js -i marker.jpg -noConf`.
The Node app writes to its `src/output/`. Both read the print resolution from the JPEG header,
and the Python package falls back to 150 dpi when there is none. `--dpi` overrides it. They share
the same core: on the example marker both wrote datasets with the same check results, and the Python
package took about 20 s against about 60 s for the single-threaded Node app.

## Trackability check

NFT tracking needs images that are texture-rich, non-repetitive and detailed all over. Generated
images often are not. The check reads the feature points the generator wrote, so it rates what the
tracker will use, not the image:

```bash
npm run trackability -- generated/scribbles           # or any of its .iset / .fset / .fset3
npm run trackability -- generated/scribbles --json    # the report as JSON
```

The exit code is 0 for a good or fair dataset, 1 for a poor one and 2 on an error. The logic is in
`plugins/jsartoolkit-nft/trackability.ts`, a set of pure functions over the file bytes, so the MCP
server (#8) and the editor can call it.

| Check | Measures | Warn | Fail |
|---|---|---|---|
| Detection points | FREAK points on the largest image (`.fset3`): enough corners to find the marker | < 250 | < 100 |
| Detection coverage | share of an 8 × 8 grid with a detection point, over every scale | < 0.75 | < 0.5 |
| Repetition | share of detection points whose descriptor reappears (≤ 64 of 768 bits apart) at least 10 % of the width away. The matcher keeps a match only when it beats the second best by a ratio of 0.7, so look-alike points are lost matches. | > 0.4 | > 0.7 |
| Tracking points | points at the largest scale of the `.fset`, used to follow the marker once found | < 50 | < 20 |
| Tracking coverage | share of the 8 × 8 grid with a tracking point | < 0.5 | < 0.25 |

Every threshold has a flag, for example `--repetition-warn 0.3` or `--detection-points-fail 150`,
and `--grid`, `--repeat-bits` and `--repeat-distance` change the measurements. The report also
gives the marker's size as the tracker computes it (pixels / dpi × 25.4).

The NFT generator prints its own "confidence level". That is the entropy of the grey-level
histogram. It says nothing about where the features are, or whether they repeat. The scribble
marker below scored 0.44 / 5 there (Node app 0.4.0) and tracks well. A checkerboard can score high and be useless.

### Calibration

These are the measured values the thresholds were set from (`.fset3` and `.fset` from
NFT-Marker-Creator-App 0.4.0, default level, 150 dpi for the generated images):

| Image | Detection points | Detection coverage | Repetition | Tracking points | Tracking coverage | Verdict |
|---|---|---|---|---|---|---|
| pinball (`npm run assets`) | 636 | 1.0 | 0.17 | 165 | 0.72 | good |
| kuva (`npm run assets`) | 399 | 0.92 | 0.26 | 62 | 0.58 | good |
| random scribbles (`example:marker`, seeds 7 and 8) | 742, 752 | 1.0 | 0.19, 0.18 | 398, 412 | 1.0 | good |
| random straight-edged shapes (triangles, boxes, ellipses; 7 variants) | 646–724 (3 measured) | 1.0 | 0.39–0.56 | 278–303 (3 measured) | ≥ 0.98 | fair (2 of 7 good, at 0.39 and 0.40) |
| random discs over grey | 449 | 0.98 | 0.53 | 254 | 1.0 | fair |
| discs on the left half only | 357 | 0.53 | 0.52 | 139 | 0.5 | fair |
| 32 px checkerboard | 647 | 1.0 | 0.98 | 0 | 0 | poor |
| smooth colour gradient | 0 | 0 | 0 | 0 | 0 | poor |

### Making images that track

- **Curves over straight edges.** Random straight-edged shapes give corners that look alike, and
  curves give corners that differ.
- **Detail everywhere.** Empty or flat areas leave holes in the coverage, and the marker is lost
  when the camera sees only those areas.
- **No tiles, stripes or grids.** Each repeated piece makes the matcher unsure.
- **Contrast and fine detail.** Soft gradients and blur give few points. The generator works on the
  grey-level image, so colours that differ only in hue look the same to it.

When a check fails, the report prints a hint for it. Feed the hint back into the prompt (ComfyUI)
or the retouch (Krita), regenerate the dataset and check again.

## Example: generated marker → dataset → graph with a glTF model

The example runs without any creative tool, so anyone can reproduce it. Replace step 1 with
ComfyUI or Krita, and step 4's model with a Blender export.

1. **Marker image.** `npm run example:marker` draws random-walk scribbles (seed 7, 900 × 1200 px at
   150 dpi, so 152.4 × 203.2 mm printed). It writes `generated/scribbles.jpg` and
   `generated/scribbles.provenance.json`: CC0-1.0, made by `scripts/example-pipeline.mjs`, with the
   seed, the size, the studio version and the date. `--seed`, `--width`, `--height`, `--dpi`, `--strokes` and `--out` change them.
2. **Dataset.** `nft-marker-creator -i generated/scribbles.jpg -o generated --threads 4` (or the
   Node app, then copy its `src/output/scribbles.*` into `generated/`). This takes 20 s to a minute.
3. **Check.** `npm run trackability -- generated/scribbles` should report *good*:
   742 detection points, coverage 1, repetition 0.187, 398 tracking points.
4. **Project.** `npm run example:project -- generated/scribbles` writes `generated/scribbles.zip`.
   It holds the Pinball · Three.js demo graph, with the dataset and a `scene.gltf` node in place of
   pinball and its primitive, and both files as uploaded assets. The model is `public/models/cube.glb`
   at 60 mm per unit. Use `--model my.glb` (a `.glb`, or a self-contained `.gltf`) for your own and
   `--scale` to size it.
5. **Studio.** `npm run dev`, then *Import…* the `.zip`, print the marker at 100 %, and point the
   camera at it. Importing a project **replaces the current graph and all uploaded assets**:
   export your work first (*Export → Project (.zip)*). When this example was written, the marker
   tracked in the player with a real camera, and the Node tracker (as in
   `tests/integration/nft-session.test.ts`) found it on the first frame, letterboxed in a
   320 × 240 frame. Both were one-off checks: CI cannot run the generator.

### A model from Blender

Ask the agent to model the object, then to export it with *File → Export → glTF 2.0* as a
**binary `.glb`**, with transforms applied and textures embedded. The studio stands the model up from
glTF's +Y up onto the marker, with its front (+Z) towards the marker's bottom edge. Blender works
in metres, so `--scale 1000` (or *Scale (mm / unit)* = 1000 in the node) shows the model at its real
size.

### Prompts that work

- *ComfyUI:* "A highly detailed, high-contrast illustration with many distinct shapes and curves
  filling the whole frame, no repeating patterns, no large flat areas, no text, sharp focus."
  Generate at the printed aspect ratio, then run the check.
- *Krita:* "The trackability check says detection coverage is 0.55 and the right third is empty:
  add detailed, varied drawing there without repeating what is already on the left."
- *Blender:* "Model a low-poly lantern about 8 cm tall, origin at the bottom centre, apply all
  transforms, and export it as a .glb with embedded textures to generated/lantern.glb."

## Left for later

- **An MCP tool for the check.** The studio's MCP server (#8) will expose the check as a tool by
  calling `checkTrackability` on the dataset bytes. The function and the report shape are ready for
  it.
- **Dataset generation in the editor.** The roadmap's in-editor generation would run the generator
  in a worker and show this report before the upload.
