---
name: explainer
description: Explain a topic, design, diff or result with the output format that is easiest to understand - ASD-STE100 text, a diagram, an interactive HTML page, or a narrated explainer video. Use when the user asks to explain, visualize, diagram, teach, or make an explainer, or when a long text answer will be hard to read.
---

# Explainer

Text is the slowest format to read. Pick the most visual format that the task deserves.
Generated pages and videos are cheap and can be discarded. Do not hold back on effort.

## Format ladder

Start at the format the user asks for. If the user does not ask, start at the lowest format that is sufficient.

| Format | Use when | Cost |
|--------|----------|------|
| 1. STE text | Short answer, one idea, terminal reply | Lowest |
| 2. Diagram | Structure, flow, sequence, state, dependencies | Low |
| 3. HTML page | Many parts, comparison, data, interaction, a report for other people | Medium |
| 4. Video | Process or idea that changes over time, a topic to teach | High |

## 1. STE text

Write in ASD-STE100 Simplified Technical English, about 80% strict:

- One idea per sentence. Procedural sentence: max 20 words. Descriptive sentence: max 25 words.
- Max 6 sentences per paragraph. One topic per paragraph.
- Active voice. Simple present tense when true. Imperative for instructions ("Run X").
- Same word for the same thing every time. Do not rotate synonyms.
- Noun clusters max 3 words. Do not omit "the", "a" or "this" when that makes the text unclear.
- Use approved simple words: "use" not "utilize", "start" not "commence", "before" not "prior to", "about" not "approximately", "make sure" not "ensure", "to" not "in order to".
- Use vertical lists for complex text.
- Safety: "WARNING:" for risk of injury or data loss, "CAUTION:" for risk of damage. Give the command first, then the risk.
- Keep code, commands, paths, API names and quoted errors exact. STE rules do not apply inside them.

## 2. Diagram

- Use Mermaid in a fenced ```mermaid block for terminal or Markdown output.
- Use inline SVG inside an HTML page when layout matters.
- Show the real mechanism: real component names, real data flow, real order. Do not draw generic boxes.
- Max about 12 nodes per diagram. Split bigger systems into several diagrams.
- Label every arrow with what moves (data, call, event).

## 3. HTML page

- Make one self-contained HTML file. Inline CSS and JS. Load libraries only from a CDN that the host allows.
- Put the answer at the top. Put detail below it or behind tabs, toggles or hover.
- Use diagrams, tables, small multiples and annotated examples instead of paragraphs.
- Write the page text in STE (section 1).
- Make it work at phone width and in light and dark themes.
- If the host has an Artifact tool, publish the page with it. Else save the file and give the path.
- In a git project, commit report pages to the repo (`artifacts/` or `docs/reviews/`).

## 4. Video

Make a 3Blue1Brown-style explainer: animated visuals plus narration. The pipeline below was tested on Windows with no `ffmpeg` command and no LaTeX.

1. Write a script in STE. Split it into lines. Each line has one idea, the narration text and the animations.
2. Make a venv outside the repo and install Manim Community: `python -m venv vid` then `vid/Scripts/pip install manim` (`vid/bin/pip` on macOS and Linux). Manim muxes audio with PyAV, so you do not need the `ffmpeg` command.
3. Copy `narrate.py` from this skill folder next to the scene file. Run `python narrate.py` once to check the voice. The voice order:
   - ElevenLabs, if `ELEVENLABS_API_KEY` is set. `ELEVENLABS_VOICE_ID` changes the voice.
   - Piper, if `piper` is on PATH and `PIPER_MODEL` is set. Free, local, better than the OS voice.
   - The built-in OS voice (Windows SAPI, macOS `say`, Linux `espeak-ng`). Free, no install, robotic.
   - Never print or commit an API key.
4. Write the scene. `say()` plays one narration line with its animations, then holds the frame until the line ends. Use `Text`, not `MathTex`, unless LaTeX is installed.

   ```python
   from manim import *
   from narrate import say

   class Explainer(Scene):
       def construct(self):
           title = Text("How the review panel works", font_size=44).to_edge(UP)
           say(self, "This video shows how the harness reviews one ticket.", Write(title))
   ```

5. Render at low quality first: `manim -ql scene.py Explainer`. Audio is cached by text, so the next render does not make it again.
6. Check frames before you report. Decode frames with PyAV (`av.open(mp4)`, `frame.to_image().save(...)`) and read the images. Fix overlaps, text off the screen and text that you cannot read. Then render again.
7. Render the final video: `manim -qh scene.py Explainer` (1080p).
8. Report the MP4 path, the length, the voice that you used and any fallback.

Before a long render, tell the user the plan and the expected time.
