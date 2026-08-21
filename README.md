# Guitarica Corrected

This project keeps the existing Guitarica frontend experience and uses the `web-app` single-model transcription pipeline for sheet and piano-roll generation.

## Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

The Flask backend runs on `http://localhost:5001`.

The backend requires `ffmpeg` for YouTube downloads and browser recordings. The model files are already under `backend/model/`.

## Frontend

In another terminal:

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`.

Vite proxies `/transcribe`, `/transcribe_youtube`, `/youtube_metadata`, and `/download` to the Flask backend.

## Response model

The backend returns the single-model result with source metadata, BPM/sample metadata, `pianoroll.notes`, and artifact/audio URLs. It does not return ensemble variants, confidence arrays, or output metrics.
