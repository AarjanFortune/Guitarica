"""
Web server: upload an audio file, get the full guitar-tab transcription
+ visualization back automatically. No manual path editing at any point.

Run with:  python app.py
Then open: http://localhost:5001
"""

import os
import re
import uuid
import shutil
import subprocess
import traceback
import socket

import librosa
import numpy as np

from flask import Flask, request, jsonify, send_file, render_template

from pipeline import build_notes_from_tab, get_config, run_full_pipeline

try:
    import yt_dlp
except ImportError:
    yt_dlp = None

app = Flask(__name__)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
OUTPUT_DIR = os.path.join(BASE_DIR, "outputs")

os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

# .webm / .ogg-opus / .mp4(-aac) are what browsers' MediaRecorder produces
# when capturing microphone audio, so they're allowed alongside regular
# file-upload formats. They get transcoded to .wav server-side (see
# _ensure_wav below) before being handed to the pipeline, since librosa /
# piano_transcription_inference are most reliable with wav input.
ALLOWED_EXTENSIONS = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".webm", ".mp4"}
NEEDS_TRANSCODE = {".webm", ".mp4"}

# Accepts youtube.com/watch?v=, youtu.be/, youtube.com/shorts/, with or
# without scheme/www, and ignores any extra query params after the id.
YOUTUBE_URL_RE = re.compile(
    r"^(https?://)?(www\.)?(m\.)?"
    r"(youtube\.com/(watch\?v=|shorts/)|youtu\.be/)[\w-]+"
)

# Cap downloaded audio so a stray long video/livestream link can't hang the
# server or fill the disk. Adjust if you need longer source material.
YOUTUBE_MAX_FILESIZE = 200 * 1024 * 1024  # 200 MB (post-download audio-only size)


def _find_available_port(preferred_port):
    port = int(preferred_port)
    for candidate in range(port, port + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            if sock.connect_ex(("127.0.0.1", candidate)) != 0:
                return candidate
    return port


def _ensure_wav(audio_path):
    """
    If the uploaded audio isn't in a format the pipeline reliably reads
    (e.g. .webm/.mp4 from a browser microphone recording), transcode it to
    a 16-bit PCM .wav alongside it using ffmpeg and return the new path.
    Otherwise return the original path unchanged.
    """
    ext = os.path.splitext(audio_path)[1].lower()
    if ext not in NEEDS_TRANSCODE:
        return audio_path

    if shutil.which("ffmpeg") is None:
        raise RuntimeError(
            "Received a microphone recording (%s) but ffmpeg is not installed "
            "on the server, so it can't be converted to wav. "
            "Install it with: sudo apt-get install ffmpeg" % ext
        )

    wav_path = os.path.splitext(audio_path)[0] + ".wav"
    cmd = [
        "ffmpeg", "-y", "-i", audio_path,
        "-ac", "1", "-ar", "44100",
        wav_path,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0 or not os.path.isfile(wav_path):
        raise RuntimeError(f"Failed to convert recorded audio to wav: {proc.stderr[-800:]}")

    return wav_path


def _download_youtube_audio(url, session_dir):
    """
    Download the audio track of a YouTube video and extract it to a 16-bit
    PCM .wav in session_dir, using yt-dlp + ffmpeg (same ffmpeg dependency
    already used by _ensure_wav). Returns (wav_path, video_title).
    """
    url = (url or "").strip()
    if not url:
        raise ValueError("No YouTube URL provided.")
    if not YOUTUBE_URL_RE.match(url):
        raise ValueError("That doesn't look like a youtube.com or youtu.be video URL.")

    if yt_dlp is None:
        raise RuntimeError(
            "yt-dlp is not installed on the server. Install it with: pip install yt-dlp"
        )
    if shutil.which("ffmpeg") is None:
        raise RuntimeError(
            "ffmpeg is not installed on the server, so downloaded audio can't be "
            "converted to wav. Install it with: sudo apt-get install ffmpeg"
        )

    out_template = os.path.join(session_dir, "yt_audio.%(ext)s")
    ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": out_template,
        "postprocessors": [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": "wav",
            "preferredquality": "0",
        }],
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "max_filesize": YOUTUBE_MAX_FILESIZE,
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
    except yt_dlp.utils.DownloadError as e:
        raise RuntimeError(f"Couldn't download that YouTube video: {e}")

    title = (info or {}).get("title", "youtube_audio")
    wav_path = os.path.join(session_dir, "yt_audio.wav")
    if not os.path.isfile(wav_path):
        raise RuntimeError("Audio extraction finished but no .wav file was produced.")

    return wav_path, title


def _result_payload(audio_path, result, source):
    data = np.load(result["npz_path"], allow_pickle=True)
    tab = data["note_tab_pred"]
    onset = data.get("note_tab_onset_pred")
    notes, _ = build_notes_from_tab(tab, onset=onset)
    bpm = float(result["bpm"])
    note_resolution = int(get_config()["note_resolution"])
    note_seconds = 60 / bpm / note_resolution * 4
    rendered_notes = [
        {
            "midi": int(note["pitch"]),
            "string": int(note["string"]),
            "fret": int(note["fret"]),
            "start_time": float(note["start"] * note_seconds),
            "duration": float(max(note["end"] - note["start"], 1) * note_seconds),
        }
        for note in notes
        if note["end"] > note["start"]
    ]
    _, sample_rate = librosa.load(audio_path, sr=None, mono=True)
    duration = float(librosa.get_duration(path=audio_path))
    session_id = os.path.basename(result["npz_path"] and os.path.dirname(result["npz_path"]))
    return {
        "status": "success",
        "source": source,
        "metadata": {
            "duration": duration,
            "sample_rate": int(sample_rate),
            "n_frames": int(tab.shape[0]),
            "tempo": bpm,
            "feature_type": "cqt",
        },
        "pianoroll": {"notes": rendered_notes, "total_duration": duration},
        "artifacts": {
            "session_id": session_id,
            "npz_url": f"/download/{session_id}/prediction.npz",
            "visualization_url": f"/download/{session_id}/tab_visualization.png",
            "midi_url": f"/download/{session_id}/tab_audio.mid",
        },
        "audio_url": f"/download/{session_id}/tab_audio.wav",
    }


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/transcribe", methods=["POST"])
def transcribe():
    if "audio" not in request.files:
        return jsonify({"error": "No audio file uploaded. Field name must be 'audio'."}), 400

    audio_file = request.files["audio"]
    if audio_file.filename == "":
        return jsonify({"error": "Empty filename."}), 400

    ext = os.path.splitext(audio_file.filename)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        return jsonify({"error": f"Unsupported file type '{ext}'."}), 400

    # Optional manual BPM override; if omitted, pipeline auto-estimates it.
    bpm_raw = request.form.get("bpm")
    bpm = float(bpm_raw) if bpm_raw not in (None, "") else None

    session_id = uuid.uuid4().hex
    session_dir = os.path.join(OUTPUT_DIR, session_id)
    os.makedirs(session_dir, exist_ok=True)

    audio_path = os.path.join(session_dir, audio_file.filename)
    audio_file.save(audio_path)

    try:
        # Browser mic recordings arrive as .webm/.mp4; transcode to .wav
        # first so the pipeline (librosa / piano-transcription) reads them
        # reliably. Regular file uploads pass through unchanged.
        audio_path = _ensure_wav(audio_path)
        result = run_full_pipeline(audio_path, session_dir, bpm=bpm)
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

    return jsonify(_result_payload(audio_path, result, {
        "kind": "upload",
        "name": os.path.basename(audio_file.filename),
        "size_bytes": os.path.getsize(audio_path),
    }))


@app.route("/transcribe_youtube", methods=["POST"])
def transcribe_youtube():
    payload = request.get_json(silent=True) or request.form
    url = (payload.get("url") or "").strip()
    if not url:
        return jsonify({"error": "No YouTube URL provided."}), 400

    bpm_raw = payload.get("bpm")
    bpm = float(bpm_raw) if bpm_raw not in (None, "") else None

    session_id = uuid.uuid4().hex
    session_dir = os.path.join(OUTPUT_DIR, session_id)
    os.makedirs(session_dir, exist_ok=True)

    try:
        audio_path, title = _download_youtube_audio(url, session_dir)
        result = run_full_pipeline(audio_path, session_dir, bpm=bpm)
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

    return jsonify(_result_payload(audio_path, result, {
        "kind": "youtube",
        "name": title,
        "size_bytes": os.path.getsize(audio_path),
        "url": url,
    }))


@app.route("/youtube_metadata", methods=["POST"])
def youtube_metadata():
    payload = request.get_json(silent=True) or request.form
    url = (payload.get("url") or "").strip()
    if not url:
        return jsonify({"error": "No YouTube URL provided."}), 400
    if yt_dlp is None:
        return jsonify({"error": "yt-dlp is not installed on the server."}), 500

    try:
        with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "skip_download": True}) as ydl:
            info = ydl.extract_info(url, download=False)
        return jsonify({
            "title": (info or {}).get("title", "YouTube video"),
            "video_id": (info or {}).get("id", ""),
            "webpage_url": (info or {}).get("webpage_url", url),
            "duration": (info or {}).get("duration"),
        })
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/download/<session_id>/<filename>")
def download(session_id, filename):
    # Basic guard against path traversal.
    if "/" in session_id or "\\" in session_id or "/" in filename or "\\" in filename:
        return jsonify({"error": "invalid path"}), 400
    path = os.path.join(OUTPUT_DIR, session_id, filename)
    if not os.path.isfile(path):
        return jsonify({"error": "file not found"}), 404
    return send_file(path)


if __name__ == "__main__":
    preferred_port = os.environ.get("PORT", "5001")
    port = _find_available_port(preferred_port)
    app.run(host="0.0.0.0", port=port, debug=False, use_reloader=False)