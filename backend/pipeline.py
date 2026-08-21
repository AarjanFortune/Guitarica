"""
Combined inference pipeline.

This module wires together the three previously-separate scripts
(inference.py, test.py, show.py) into functions that can be called
automatically from a web server, with no manual path editing.

Requires (same as before, must exist alongside this file / on PYTHONPATH):
    - tab_estimator_model.py   (TabEstimator model definition)
    - src/config.yaml          (model config)
    - model/epoch192.model     (guitar tab model checkpoint)
    - model/guitar-gaps.pth    (piano-transcription-style checkpoint)
"""

import os
import math
import shutil
import subprocess

import numpy as np
import torch
import yaml
import librosa
import pretty_midi
import matplotlib
matplotlib.use("Agg")  # headless/server-safe backend, no display needed
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches

from tab_estimator_model import TabEstimator
from piano_transcription_inference import PianoTranscription, sample_rate, load_audio

# ------------------ paths (adjust if your layout differs) ------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, "src", "config.yaml")
TAB_CHECKPOINT_PATH = os.path.join(BASE_DIR, "model", "epoch192.model")
PIANO_CHECKPOINT_PATH = os.path.join(BASE_DIR, "model", "guitar-gaps.pth")
SOUNDFONT_PATH = os.path.join(os.path.dirname(__file__), "assets", "soundfonts", "MuseScore_General.sf3")
# -----------------------------------------------------------------------------

# Models are expensive to load, so we load them once and reuse across requests.
_cfg = None
_tab_model = None
_piano_transcriptor = None


def get_config():
    global _cfg
    if _cfg is None:
        with open(CONFIG_PATH) as f:
            _cfg = yaml.safe_load(f)
    return _cfg


def get_tab_model():
    global _tab_model
    if _tab_model is None:
        cfg = get_config()
        model = TabEstimator(
            cfg["mode"],
            cfg["use_custom_decimation_func"],
            cfg["use_conv_stack"],
            cfg["cqt_n_bins"],
            cfg["hop_length"],
            cfg["down_sampling_rate"],
            encoder_heads=cfg["encoder_heads"],
            encoder_layers=cfg["encoder_layers"],
        )
        model.load_state_dict(torch.load(TAB_CHECKPOINT_PATH, map_location="cpu", weights_only=False))
        model.eval()
        _tab_model = model
    return _tab_model


def get_piano_transcriptor():
    global _piano_transcriptor
    if _piano_transcriptor is None:
        original_torch_load = torch.load

        def load_trusted_checkpoint(*args, **kwargs):
            kwargs.setdefault("weights_only", False)
            return original_torch_load(*args, **kwargs)

        torch.load = load_trusted_checkpoint
        try:
            _piano_transcriptor = PianoTranscription(
                device="cpu",
                checkpoint_path=PIANO_CHECKPOINT_PATH,
                model_type="Regress_onset_offset_frame_velocity_CRNN",
            )
        finally:
            torch.load = original_torch_load
    return _piano_transcriptor


# ---------------------------------------------------------------------------
# Step 1 (from test.py): audio -> MIDI via the piano-transcription model
# ---------------------------------------------------------------------------
def transcribe_to_midi(audio_path, output_midi_path):
    audio, _ = load_audio(audio_path, sr=sample_rate, mono=True)
    transcriptor = get_piano_transcriptor()
    transcriptor.transcribe(audio, output_midi_path)
    return output_midi_path


# ---------------------------------------------------------------------------
# Step 2 (from inference.py): audio -> CQT -> tab predictions (.npz)
# ---------------------------------------------------------------------------
def compute_cqt(audio_path, sr_target, bins_per_octave, n_bins, hop_length):
    y, sr = librosa.load(audio_path, sr=None, mono=True)
    y = librosa.util.normalize(y.astype(float))
    y = librosa.resample(y=y, orig_sr=sr, target_sr=sr_target)
    return compute_cqt_from_signal(y, sr_target, bins_per_octave, n_bins, hop_length)


def compute_cqt_from_signal(y, sr_target, bins_per_octave, n_bins, hop_length):
    cqt = np.abs(
        librosa.cqt(
            y=y,
            hop_length=hop_length,
            sr=sr_target,
            n_bins=n_bins,
            bins_per_octave=bins_per_octave,
        )
    )
    return cqt.T  # (time, n_bins)


def estimate_bpm(audio_path):
    """Auto-detect BPM so nobody has to hand-enter it (original script hardcoded BPM=129)."""
    y, sr = librosa.load(audio_path, sr=None, mono=True)
    tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
    tempo = float(np.atleast_1d(tempo)[0])
    return tempo


def get_note_window_steps(cfg):
    bars = int(cfg.get("generated_midi_n_bars", 4))
    return bars * int(cfg["note_resolution"])


def filter_note_predictions_with_onset(note_pred, f0_onset):
    if f0_onset is None:
        return note_pred

    open_pitch = [40, 45, 50, 55, 59, 64]
    filtered = note_pred.copy()
    n_frames = min(filtered.shape[0], f0_onset.shape[0])

    for t in range(n_frames):
        for string in range(6):
            fret = int(np.argmax(filtered[t, string]))
            if fret == 20:
                continue
            midi_pitch = open_pitch[string] + fret
            pitch_idx = midi_pitch - 40
            if pitch_idx < 0 or pitch_idx >= f0_onset.shape[1] or f0_onset[t, pitch_idx] <= 0:
                filtered[t, string] = 0
                filtered[t, string, 20] = 1

    return filtered


def run_tab_inference(audio_path, bpm, out_npz_path, target_note_steps=None, f0_onset=None):
    cfg = get_config()
    cqt = compute_cqt(
        audio_path,
        cfg["down_sampling_rate"],
        cfg["bins_per_octave"],
        cfg["cqt_n_bins"],
        cfg["hop_length"],
    )

    model = get_tab_model()
    note_window_steps = get_note_window_steps(cfg)

    y, sr = librosa.load(audio_path, sr=None, mono=True)
    y = librosa.util.normalize(y.astype(float))
    y = librosa.resample(y=y, orig_sr=sr, target_sr=cfg["down_sampling_rate"])

    note_dur = 60 / bpm / cfg["note_resolution"] * 4
    chunk_seconds = note_window_steps * note_dur
    chunk_samples = max(1, int(round(chunk_seconds * cfg["down_sampling_rate"])))

    if target_note_steps is None:
        target_note_steps = int(np.ceil(len(y) / chunk_samples) * note_window_steps)

    frame_preds = []
    note_preds = []
    note_onset_preds = []

    for start in range(0, len(y), chunk_samples):
        chunk = y[start:start + chunk_samples]
        if len(chunk) < chunk_samples:
            chunk = np.pad(chunk, (0, chunk_samples - len(chunk)))

        chunk_cqt = compute_cqt_from_signal(
            chunk,
            cfg["down_sampling_rate"],
            cfg["bins_per_octave"],
            cfg["cqt_n_bins"],
            cfg["hop_length"],
        )

        input_features = torch.from_numpy(chunk_cqt).float().unsqueeze(0)
        frame_len = torch.tensor([input_features.shape[1]], dtype=torch.float32)
        note_len = torch.tensor([note_window_steps], dtype=torch.float32)
        bpm_t = torch.tensor([bpm], dtype=torch.float32)

        with torch.no_grad():
            frame_pred, note_pred, note_onset_pred, olens = model(
                input_features, frame_len, note_len, bpm_t
            )

        frame_preds.append(frame_pred.squeeze(0).numpy())
        note_preds.append(note_pred.squeeze(0).numpy())
        note_onset_preds.append(note_onset_pred.squeeze(0).numpy())

    frame_pred = np.concatenate(frame_preds, axis=0) if frame_preds else np.empty((0, 6, 21), dtype=np.float32)
    note_pred = np.concatenate(note_preds, axis=0) if note_preds else np.empty((0, 6, 21), dtype=np.float32)
    note_onset_pred = np.concatenate(note_onset_preds, axis=0) if note_onset_preds else np.empty((0, 6, 21), dtype=np.float32)

    if target_note_steps is not None:
        if frame_pred.shape[0] < target_note_steps:
            pad_len = target_note_steps - frame_pred.shape[0]
            frame_pred = np.pad(frame_pred, [(0, pad_len), (0, 0), (0, 0)], mode="constant")
            note_pred = np.pad(note_pred, [(0, pad_len), (0, 0), (0, 0)], mode="constant")
            note_onset_pred = np.pad(note_onset_pred, [(0, pad_len), (0, 0), (0, 0)], mode="constant")
        else:
            frame_pred = frame_pred[:target_note_steps]
            note_pred = note_pred[:target_note_steps]
            note_onset_pred = note_onset_pred[:target_note_steps]

    note_pred = filter_note_predictions_with_onset(note_pred, f0_onset)

    olens = np.array([frame_pred.shape[0]], dtype=np.int64)

    os.makedirs(os.path.dirname(out_npz_path) or ".", exist_ok=True)
    np.savez_compressed(
        out_npz_path,
        cqt=cqt,
        frame_tab_pred=frame_pred,
        note_tab_pred=note_pred,
        note_tab_onset_pred=note_onset_pred,
        olens=olens,
        bpm=bpm,
    )
    return out_npz_path


# ---------------------------------------------------------------------------
# Step 3 (from show.py): npz + midi -> tab visualization (.png)
# ---------------------------------------------------------------------------
def midi_to_F0_onset(midi_path, tempo=120, note_resolution=16):
    midi_file = pretty_midi.PrettyMIDI(midi_path)
    note_dur = 60 / tempo / note_resolution * 4
    len_in_notes = int(
        math.ceil(round(midi_file.get_end_time() / note_dur) / (note_resolution * 4))
        * (note_resolution * 4)
    )

    F0_onset = np.zeros((len_in_notes, 44))
    for instrument in midi_file.instruments:
        for note in instrument.notes:
            t = int(round(note.start / note_dur))
            if t >= len_in_notes:
                break

            pitch = note.pitch - 40
            if 0 <= pitch < 44:
                F0_onset[t, pitch] = 1

    return F0_onset


def midi_to_note_name(midi):
    names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
    octave = midi // 12 - 1
    return f"{names[midi % 12]}{octave}"

# need to look at this build_notes_from_tab(tab, onset, tuning_midi) —
#  the single source of truth for turning the raw (T, 6, 21) fret-prediction array into discrete note events 
# ({pitch, start, end, string}). Used by both the piano-roll plot and MIDI export, so what you see matches what you hear.
def build_notes_from_tab(tab, onset=None, tuning_midi=None):
    """
    Walks the (T, 6, 21) one-hot fret prediction (class 20 = not played) and
    reconstructs discrete note events {pitch, start, end, string}, using the
    onset prediction to decide when a held fret is actually a new pick vs.
    a continuation of the previous frame, and when a same-pitch retrigger
    should split into two notes.

    start/end are in tab *frames* (not seconds) - the caller converts to
    seconds using the bpm/note_resolution in effect for that prediction.

    This is the single source of truth for "what notes does this tab
    actually contain" - both the piano-roll visualization and MIDI/audio
    synthesis are built from it, so what you see and what you hear always
    match the tab model's output (not any auxiliary onset-detection model).
    """
    if tuning_midi is None:
        tuning_midi = [40, 45, 50, 55, 59, 64]

    n_frames, n_strings, _ = tab.shape
    active_pitches = set()
    notes = []
    open_notes = {}

    for t in range(n_frames):
        for s in range(n_strings):
            fret = int(np.argmax(tab[t, s]))
            played = fret != 20

            onset_flag = False
            if played and onset is not None:
                try:
                    onset_flag = onset[t, s, fret] > 0
                except Exception:
                    onset_flag = False

            if played and onset is not None and not onset_flag and s not in open_notes:
                played = False

            if played:
                pitch = tuning_midi[s] + fret
                active_pitches.add(pitch)

                if s in open_notes:
                    same_pitch = open_notes[s]["pitch"] == pitch
                    retrigger = onset is not None and onset_flag and t > open_notes[s]["start"]
                    if same_pitch and not retrigger:
                        continue
                    notes.append({"pitch": open_notes[s]["pitch"], "start": open_notes[s]["start"], "end": t, "string": s, "fret": open_notes[s]["fret"]})
                    open_notes[s] = {"pitch": pitch, "start": t, "fret": fret}
                else:
                    open_notes[s] = {"pitch": pitch, "start": t, "fret": fret}
            elif s in open_notes:
                notes.append({"pitch": open_notes[s]["pitch"], "start": open_notes[s]["start"], "end": t, "string": s, "fret": open_notes[s]["fret"]})
                del open_notes[s]

    for s, note in open_notes.items():
        notes.append({"pitch": note["pitch"], "start": note["start"], "end": n_frames, "string": s, "fret": note["fret"]})

    return notes, active_pitches


def synthesize_audio_from_tab(npz_path, bpm, out_wav_path, note_resolution=16, sample_rate=22050,
                              tuning_midi=None):
    midi_path = os.path.join(os.path.dirname(out_wav_path) or ".", "tab_audio.mid")
    
    midii_path = os.path.join(os.path.dirname(out_wav_path) or ".", "output.mid")
    os.makedirs(os.path.dirname(midi_path), exist_ok=True)
    tab_to_midi(npz_path, bpm, midi_path, note_resolution=note_resolution, instrument_program=24)

    if not os.path.exists(SOUNDFONT_PATH):
        raise FileNotFoundError(
            f"SoundFont not found: {SOUNDFONT_PATH}. Download MuseScore_General.sf3 first."
        )

    fluidsynth_path = shutil.which("fluidsynth")
    if not fluidsynth_path:
        raise FileNotFoundError("fluidsynth executable not found on PATH")


    command = [
        fluidsynth_path,
        "-ni",
        "-F", str(out_wav_path),
        "-r", str(sample_rate),
        "-g", "0.95",
        str(SOUNDFONT_PATH),
        str(midi_path)
    ]

    try:
        # Run and raise an explicit Python exception if FluidSynth fails
        result = subprocess.run(
            command, 
            check=True, 
            stdout=subprocess.PIPE, 
            stderr=subprocess.PIPE,
            text=True
        )
    except subprocess.CalledProcessError as e:
        print("--- FluidSynth Error Log ---")
        print("STDERR:", e.stderr)
        print("STDOUT:", e.stdout)
        raise e

    # command = [
    #     fluidsynth_path,
    #     "-ni",
    #     SOUNDFONT_PATH,
    #     midi_path,
    #     "-F",
    #     out_wav_path,
    #     "-r",
    #     str(sample_rate),
    #     "-g",
    #     "0.95",
    # ]
    # print("Saving WAV to:", os.path.abspath(out_wav_path))
    # subprocess.run(command, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return out_wav_path




def plot_piano_roll(ax, tab, note_resolution, onset=None, tuning_midi=None):
    if tuning_midi is None:
        tuning_midi = [40, 45, 50, 55, 59, 64]

    string_colors = {0: "#e76f51", 1: "#e9c46a", 2: "#4d96ff", 3: "#ff7f50", 4: "#2a9d8f", 5: "#8e44ad"}
    string_names = ["E", "A", "D", "G", "B", "e"]

    n_frames, n_strings, _ = tab.shape
    notes, active_pitches = build_notes_from_tab(tab, onset=onset, tuning_midi=tuning_midi)

    if not active_pitches:
        ax.text(0.5, 0.5, "No notes played", ha="center", va="center", transform=ax.transAxes)
        ax.axis("off")
        return

    sorted_pitches = sorted(active_pitches)
    pitch_to_row = {p: i for i, p in enumerate(sorted_pitches)}
    n_rows = len(sorted_pitches)

    ax.hlines(y=list(range(n_rows)), xmin=0, xmax=n_frames, colors="#d0d0d0", lw=0.8, zorder=0)
    for t in range(n_frames + 1):
        if t % note_resolution == 0:
            ax.vlines(x=t, ymin=-0.5, ymax=n_rows - 0.5, colors="#666666", lw=0.9, zorder=0)
        elif t % 4 == 0:
            ax.vlines(x=t, ymin=-0.5, ymax=n_rows - 0.5, colors="#aaaaaa", lw=0.6, zorder=0)

    for note in notes:
        width = note["end"] - note["start"]
        if width <= 0:
            continue
        row = pitch_to_row[note["pitch"]]
        color = string_colors.get(note["string"], "#222222")
        rect = mpatches.Rectangle((note["start"], row - 0.42), width, 0.84, facecolor=color, edgecolor="#222222", linewidth=0.5, zorder=5)
        ax.add_patch(rect)

    ax.set_yticks(range(n_rows))
    ax.set_yticklabels([midi_to_note_name(p) for p in sorted_pitches])
    ax.set_xticks([i for i in range(0, n_frames + 1) if i % note_resolution == 0])
    ax.set_xticklabels([i for i in range(0, n_frames // note_resolution + 1)])
    ax.set_xlim(0, n_frames)
    ax.set_ylim(-0.5, n_rows - 0.5)
    ax.set_xlabel("Bar number")
    ax.set_ylabel("Pitch")
    ax.tick_params(axis="x", labelsize=10, length=0, pad=6, colors="#333333")
    ax.tick_params(axis="y", labelsize=10, length=0, colors="#333333")
    for spine in ax.spines.values():
        spine.set_visible(False)

    handles = [mpatches.Patch(color=string_colors[s], label=string_names[s]) for s in range(n_strings)]
    ax.legend(
        handles=handles,
        loc="upper left",
        bbox_to_anchor=(1.01, 1.0),
        borderaxespad=0,
        fontsize=9,
        ncol=1,
        frameon=False,
        title="String",
        title_fontsize=9,
    )


def generate_visualization(npz_path, out_png_path, note_resolution=16):
    d = np.load(npz_path, allow_pickle=True)
    tab = d["note_tab_pred"]
    note_onset = d.get("note_tab_onset_pred")

    n_frames = tab.shape[0]
    note_onset_aligned = None if note_onset is None else note_onset[:n_frames]

    total_frames = len(tab)
    frames_per_row = note_resolution * 4
    n_tab_rows = max(1, int(np.ceil(total_frames / frames_per_row)))

    fig_height = max(6.0, n_tab_rows * 2.2 + 5.2)
    fig = plt.figure(figsize=(max(16, 4 * 3.5 + 2), fig_height))
    fig.patch.set_facecolor("white")
    # Extra row (index n_tab_rows) is a blank spacer that guarantees vertical
    # breathing room between the last tab row's x-axis labels/title and the
    # piano roll's title, instead of relying on a single uniform hspace.
    grid = fig.add_gridspec(
        n_tab_rows + 2,
        1,
        height_ratios=[1] * n_tab_rows + [0.35, 1.5],
        hspace=0.45,
    )

    tab_axes = [fig.add_subplot(grid[i, 0]) for i in range(n_tab_rows)]
    for ax in tab_axes:
        ax.set_facecolor("white")

    # Render wrapped tab rows.
    for row_index, ax in enumerate(tab_axes):
        start = row_index * frames_per_row
        end = min(start + frames_per_row, total_frames)
        row_tab = tab[start:end]
        row_onset = None if note_onset_aligned is None else note_onset_aligned[start:end]
        row_len = len(row_tab)

        note_spacing = 1.5
        note_offset = note_spacing * 1.5
        bar_label_offset = note_spacing

        ax.hlines(y=[0, 1, 2, 3, 4, 5], xmin=0, xmax=row_len * note_spacing, colors="#cfcfcf", lw=0.9, zorder=0)
        for time in range(row_len):
            x_pos = time * note_spacing + note_offset
            if time % note_resolution == 0:
                ax.vlines(x=x_pos, ymin=0, ymax=5, colors="#5a5a5a", lw=1.0, zorder=0)
            elif time % 4 == 0:
                ax.vlines(x=x_pos, ymin=0, ymax=5, colors="#a2a2a2", lw=0.7, zorder=0)
            else:
                ax.vlines(x=x_pos, ymin=0, ymax=5, colors="#d6d6d6", lw=0.45, ls="dotted", zorder=0)

            for string in range(6):
                fret = np.argmax(row_tab[time, string])
                if fret != 20:
                    onset_present = True
                    if row_onset is not None:
                        onset_present = row_onset[time, string, fret] > 0
                    if onset_present:
                        ax.text(
                            x_pos, string, str(fret),
                            ha="center", va="center",
                            color="#111111", fontsize=12, fontweight="600",
                            family="DejaVu Sans", zorder=5,
                        )

        ax.vlines(x=row_len * note_spacing, ymin=0, ymax=5.0, colors="#5a5a5a", lw=1.0)
        ax.set_yticks(np.arange(6))
        ax.set_yticklabels(("E", "A", "D", "G", "B", "e"))
        ax.set_ylim(-0.5, 5.5)
        ax.set_xlim(0, max(row_len * note_spacing + note_offset, note_spacing))
        ax.tick_params(axis="y", labelsize=12, length=0, colors="#333333")
        ax.tick_params(axis="x", labelsize=11, length=0, pad=8, colors="#333333")
        for spine in ax.spines.values():
            spine.set_visible(False)

        bar_ticks = [i * note_resolution * note_spacing + bar_label_offset for i in range((row_len // note_resolution) + 1)]
        bar_labels = [start // note_resolution + i for i in range(len(bar_ticks))]
        ax.set_xticks(bar_ticks)
        ax.set_xticklabels(bar_labels)
        ax.set_xlabel("Bar number")
        if row_index == 0:
            ax.set_title("Guitar Tablature", fontsize=18, pad=16, color="#111111")

    spacer_ax = fig.add_subplot(grid[n_tab_rows, 0])
    spacer_ax.axis("off")

    piano_roll_ax = fig.add_subplot(grid[n_tab_rows + 1, 0])
    piano_roll_ax.set_facecolor("white")
    plot_piano_roll(piano_roll_ax, tab, note_resolution, onset=note_onset_aligned)
    piano_roll_ax.set_title("Piano Roll View", fontsize=16, pad=14, color="#111111")

    os.makedirs(os.path.dirname(out_png_path) or ".", exist_ok=True)
    plt.savefig(out_png_path, dpi=180, bbox_inches="tight", facecolor="white")
    plt.close()
    return out_png_path


def tab_to_midi(npz_path, bpm, out_midi_path, note_resolution=16,
                 tuning_midi=None, instrument_program=24, velocity=90):
    """
    Builds a real, playable MIDI file directly from the tab model's own
    prediction (prediction.npz), NOT from the auxiliary piano-transcription
    output.mid. This is what should be used for audio synthesis/playback,
    since it's guaranteed to match what the tab visualization shows.

    instrument_program: General MIDI program number. Default 24 is
    "Acoustic Guitar (nylon)".
    """
    d = np.load(npz_path, allow_pickle=True)
    tab = d["note_tab_pred"]
    onset = d.get("note_tab_onset_pred")

    notes, _ = build_notes_from_tab(tab, onset=onset, tuning_midi=tuning_midi)

    note_dur = 60 / bpm / note_resolution * 4  # seconds per tab frame

    midi = pretty_midi.PrettyMIDI(initial_tempo=bpm)
    instrument = pretty_midi.Instrument(program=instrument_program, name="Guitar (from tab)")

    for note in notes:
        start = note["start"] * note_dur
        end = max(note["end"] * note_dur, start + note_dur * 0.5)  # avoid zero-length notes
        instrument.notes.append(
            pretty_midi.Note(velocity=velocity, pitch=note["pitch"], start=start, end=end)
        )

    instrument.notes.sort(key=lambda n: n.start)
    midi.instruments.append(instrument)

    os.makedirs(os.path.dirname(out_midi_path) or ".", exist_ok=True)
    midi.write(out_midi_path)
    return out_midi_path


# ---------------------------------------------------------------------------
# Full pipeline: this is the single entry point the web server should call.
# ---------------------------------------------------------------------------
def run_full_pipeline(audio_path, work_dir, bpm=None, note_resolution=16):
    """
    Runs everything automatically for one uploaded audio file:
      1. piano-transcription-style model -> MIDI
      2. CQT + TabEstimator -> tab predictions (.npz)
      3. visualization -> .png

    Returns a dict of output file paths + the bpm used.
    """
    os.makedirs(work_dir, exist_ok=True)

    if bpm is None:
        bpm = estimate_bpm(audio_path)

    midi_path = os.path.join(work_dir, "output.mid")
    transcribe_to_midi(audio_path, midi_path)
    f0_onset = midi_to_F0_onset(midi_path, tempo=bpm, note_resolution=note_resolution)

    npz_path = os.path.join(work_dir, "prediction.npz")
    run_tab_inference(audio_path, bpm, npz_path, target_note_steps=f0_onset.shape[0], f0_onset=f0_onset)

    png_path = os.path.join(work_dir, "tab_visualization.png")
    generate_visualization(npz_path, png_path, note_resolution=note_resolution)

    audio_path_out = os.path.join(work_dir, "tab_audio.wav")
    synthesize_audio_from_tab(npz_path, bpm, audio_path_out, note_resolution=note_resolution)


    # note this synthesize_audio_from_tab() is generating from tab_audio.mid which is desired and is also responsbile for background playback but it is not saving wav file

    return {
        "bpm": bpm,
        "npz_path": npz_path,
        "png_path": png_path,
        "audio_path": audio_path_out,
    }

