# AYW0.github.io

Alexander Wang's personal site — hand-authored static HTML (no framework/theme).

## Structure

```
index.html                  Landing page (home)
storymode/index.html        "The other side" — interactive experience
maringba/                   Selected publication: MARingBA
  index.html                  demo/project page
  MARingBAfigureedit.png      figure (also used as the home teaser/poster)
  MARINGBA-*.mp3              audio examples
  maringba.mp4                (optional) 30s preview video — drop it here
musicassistant/             Selected publication: Music-Aware Virtual Assistants
  index.html
  MVAfigure.png
  MVA-*.mp3
  musicassistant.mp4          (optional) 30s preview video — drop it here
assets/
  css/                      home.css, project.css, storymode.css
  js/                       vplayer.js, storymode/ (particles, music, dialogue)
images/                     shared images (profile, favicons, other-pub figures)
files/                      misc downloads (paper PDFs)
_archive/                   OLD academicpages Jekyll theme + content (unused;
                            ignored by Jekyll, safe to delete when ready)
```

## Adding material to a publication
Each selected publication is a self-contained folder. Drop new figures,
audio, or a `*.mp4` preview into `maringba/` or `musicassistant/` and
reference them relatively from that folder's `index.html`.

## Hosting
Everything is static and served from natural paths (`/`, `/storymode/`,
`/maringba/`, `/musicassistant/`). No build step is required. The minimal
`_config.yml` only exists so a default GitHub Pages Jekyll build copies the
files and skips `_archive/`.

## Local preview
```
python3 -m http.server 8000
```
then open http://localhost:8000/
