import { useEffect, useRef, useState } from 'react'
import { Session } from '@supabase/supabase-js'

interface ActiveNote {
  stringIdx: number
  fret: number
}

const STRING_LABELS = ['e', 'B', 'G', 'D', 'A', 'E']

export default function LiveInputPanel({ session }: { session: Session | null }) {
  const [isRecording, setIsRecording] = useState(false)
  const [statusText, setStatusText] = useState('Ready')
  const [activeNotes, setActiveNotes] = useState<ActiveNote[]>([])

  const wsRef = useRef<WebSocket | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const stoppingRef = useRef(false)

  const stopStreaming = () => {
    stoppingRef.current = true
    setIsRecording(false)
    setActiveNotes([])

    if (wsRef.current) {
      if (wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'finish' }))
      }
      wsRef.current.close()
      wsRef.current = null
    }

    processorRef.current?.disconnect()
    processorRef.current = null

    audioContextRef.current?.close()
    audioContextRef.current = null

    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    setStatusText('Session ended')
  }

  const startStreaming = async () => {
    try {
      if (!session?.access_token) {
        setStatusText('Sign in to start a protected live session')
        return
      }
      stoppingRef.current = false
      setStatusText('Requesting microphone access')
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      const configuredUrl = import.meta.env.VITE_LIVE_WS_URL as string | undefined
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const wsUrl = configuredUrl || `${protocol}://${window.location.host}/ws/live`
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        setStatusText('Securing session')
        ws.send(JSON.stringify({ type: 'authenticate', access_token: session.access_token }))
      }

      const beginAudio = () => {
        setStatusText('Listening')
        setIsRecording(true)

        const AudioContextClass = window.AudioContext
        const audioContext = new AudioContextClass({ sampleRate: 44100 })
        audioContextRef.current = audioContext

        const source = audioContext.createMediaStreamSource(stream)
        const processor = audioContext.createScriptProcessor(4096, 1, 1)
        processorRef.current = processor

        processor.onaudioprocess = (event) => {
          const inputData = event.inputBuffer.getChannelData(0)
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'audio_chunk',
              data: Array.from(inputData),
              tempo: 120,
            }))
          }
        }

        source.connect(processor)
        processor.connect(audioContext.destination)
      }

      ws.onmessage = (event) => {
        const response = JSON.parse(event.data)
        if (response.type === 'authenticated') {
          beginAudio()
          return
        }
        if (response.type === 'session_limit') {
          setStatusText('Live session limit reached')
          stopStreaming()
          return
        }
        if (response.type !== 'transcription' || !Array.isArray(response.tab) || response.tab.length === 0) {
          return
        }

        const latestFrame = response.tab[response.tab.length - 1]
        const notes = latestFrame
          .map((fret: number, stringIdx: number) => ({ fret, stringIdx: 5 - stringIdx }))
          .filter((note: ActiveNote) => note.fret >= 0 && note.fret < 30)

        setActiveNotes(notes)
      }

      ws.onerror = () => {
        setStatusText('Connection error')
        stopStreaming()
      }

      ws.onclose = () => {
        if (!stoppingRef.current) {
          setStatusText('Live server unavailable')
          setIsRecording(false)
          streamRef.current?.getTracks().forEach((track) => track.stop())
        }
      }
    } catch {
      setStatusText('Microphone unavailable')
      setIsRecording(false)
    }
  }

  useEffect(() => stopStreaming, [])

  return (
    <section className="input-section live-section" aria-labelledby="live-title">
      <div className="section-heading">
        <span>Live input</span>
        <h1 id="live-title">Play</h1>
      </div>

      <div className="fretboard" aria-label="Live fretboard">
        {STRING_LABELS.map((label, stringIdx) => (
          <div className="fretboard-string" key={label}>
            <span>{label}</span>
            <div className="fretboard-line">
              {Array.from({ length: 12 }).map((_, fretIdx) => (
                <i key={fretIdx} />
              ))}
              {activeNotes
                .filter((note) => note.stringIdx === stringIdx)
                .map((note, noteIdx) => (
                  <b
                    key={`${stringIdx}-${note.fret}-${noteIdx}`}
                    style={{ left: `${Math.min(note.fret, 12) / 12 * 100}%` }}
                  >
                    {note.fret}
                  </b>
                ))}
            </div>
          </div>
        ))}
      </div>

      <button
        type="button"
        className={isRecording ? 'live-mic-action live-mic-active' : 'live-mic-action'}
        onClick={isRecording ? stopStreaming : startStreaming}
      >
        <span aria-hidden="true"><MicIcon /></span>
        <strong>{isRecording ? 'Stop listening' : 'Start listening'}</strong>
        <small>{statusText}</small>
      </button>
    </section>
  )
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" focusable="false">
      <path d="M12 14.5a3.1 3.1 0 0 0 3.1-3.1V6.6a3.1 3.1 0 0 0-6.2 0v4.8a3.1 3.1 0 0 0 3.1 3.1Z" />
      <path d="M6.8 11.3a5.2 5.2 0 0 0 10.4 0" />
      <path d="M12 16.5V20" />
      <path d="M9 20h6" />
    </svg>
  )
}
