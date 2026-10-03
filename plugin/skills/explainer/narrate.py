"""Narration for explainer videos made with Manim.

Voice order:
1. ElevenLabs, when ELEVENLABS_API_KEY is set (ELEVENLABS_VOICE_ID picks the voice).
2. Piper, when the `piper` command is on PATH and PIPER_MODEL names a voice model.
3. The built-in OS voice: Windows SAPI, macOS `say`, Linux `espeak-ng`.

Audio is cached by text, so a low-quality render and the final render use the same files.

Run `python narrate.py` to check that one voice works on this machine.
"""

import hashlib
import json
import os
import platform
import shutil
import subprocess
import urllib.request
from pathlib import Path

import av


def narrate(text, voice_dir="voice"):
    """Write `text` as speech. Return (audio path, length in seconds)."""
    Path(voice_dir).mkdir(parents=True, exist_ok=True)
    stem = Path(voice_dir) / hashlib.sha1(text.encode()).hexdigest()[:12]
    for cached in (stem.with_suffix(".mp3"), stem.with_suffix(".wav")):
        if cached.exists():
            return cached, duration(cached)

    key = os.environ.get("ELEVENLABS_API_KEY")
    if key:
        path = stem.with_suffix(".mp3")
        voice = os.environ.get("ELEVENLABS_VOICE_ID", "JBFqnCBsd6RMkjVDRZzb")
        request = urllib.request.Request(
            f"https://api.elevenlabs.io/v1/text-to-speech/{voice}",
            data=json.dumps({"text": text, "model_id": "eleven_multilingual_v2"}).encode(),
            headers={"xi-api-key": key, "Content-Type": "application/json", "Accept": "audio/mpeg"},
        )
        with urllib.request.urlopen(request, timeout=120) as response:
            path.write_bytes(response.read())
    elif os.environ.get("PIPER_MODEL") and shutil.which("piper"):
        path = stem.with_suffix(".wav")
        subprocess.run(
            ["piper", "--model", os.environ["PIPER_MODEL"], "--output_file", str(path)],
            input=text.encode(), check=True,
        )
    else:
        path = stem.with_suffix(".wav")
        os_voice(text, path)
    return path, duration(path)


def os_voice(text, path):
    system = platform.system()
    if system == "Windows":
        # Text goes through an environment variable, so quotes in it cannot break the command.
        script = (
            "Add-Type -AssemblyName System.Speech;"
            "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;"
            "$s.SetOutputToWaveFile($env:NARRATE_OUT); $s.Speak($env:NARRATE_TEXT); $s.Dispose()"
        )
        env = {**os.environ, "NARRATE_OUT": str(Path(path).resolve()), "NARRATE_TEXT": text}
        subprocess.run(["powershell", "-NoProfile", "-Command", script], env=env, check=True)
    elif system == "Darwin":
        subprocess.run(["say", "--file-format=WAVE", "--data-format=LEI16@22050", "-o", str(path), text], check=True)
    else:
        subprocess.run(["espeak-ng", "-w", str(path), text], check=True)


def duration(path):
    with av.open(str(path)) as container:
        return container.duration / av.time_base


def say(scene, text, *animations, voice_dir="voice"):
    """Play one narration line with its animations. Hold the frame until the line ends."""
    path, seconds = narrate(text, voice_dir)
    scene.add_sound(str(path))
    run_time = 0.0
    if animations:
        run_time = min(1.5, seconds)
        scene.play(*animations, run_time=run_time)
    scene.wait(max(seconds - run_time, 0) + 0.3)


if __name__ == "__main__":
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        path, seconds = narrate("Voice check. One, two, three.", tmp)
        assert path.exists() and seconds > 0.5, (path, seconds)
        print(f"ok {path.suffix} {seconds:.1f}s")
