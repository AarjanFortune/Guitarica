import { TranscribedNote } from '../types/transcription'

interface CustomTabSheetProps {
  notes: TranscribedNote[]
  tempo: number
  duration: number
}

const STRING_LABELS = ['e', 'B', 'G', 'D', 'A', 'E']
const BARS_PER_ROW = 2

export default function CustomTabSheet({ notes, tempo, duration }: CustomTabSheetProps) {
  const barDuration = 240 / Math.max(tempo, 1)
  const rowDuration = barDuration * BARS_PER_ROW
  const rowCount = Math.max(1, Math.ceil(Math.max(duration, 1) / rowDuration))

  return (
    <div className="custom-sheet" aria-label="Generated Guitarica sheet">
      {Array.from({ length: rowCount }).map((_, rowIndex) => {
        const rowStart = rowIndex * rowDuration
        const rowEnd = rowStart + rowDuration
        const rowNotes = notes.filter((note) => note.time >= rowStart && note.time < rowEnd)

        return (
          <section className="sheet-row" key={rowStart}>
            <div className="sheet-row-meta">
              <span>{rowIndex * BARS_PER_ROW + 1}</span>
              <small>{formatTime(rowStart)}</small>
            </div>

            <div className="sheet-string-labels" aria-hidden="true">
              {STRING_LABELS.map((label, stringIdx) => (
                <span key={`${label}-${stringIdx}`} style={{ top: `${stringTop(stringIdx)}%` }}>
                  {label}
                </span>
              ))}
            </div>

            <div className="sheet-staff">
              {Array.from({ length: BARS_PER_ROW + 1 }).map((__, barIndex) => (
                <i
                  key={barIndex}
                  className="sheet-bar"
                  style={{ left: `${(barIndex / BARS_PER_ROW) * 100}%` }}
                />
              ))}

              {STRING_LABELS.map((label, stringIdx) => (
                <div className="sheet-string" key={`${label}-${stringIdx}`} style={{ top: `${stringTop(stringIdx)}%` }} />
              ))}

              {rowNotes.map((note, index) => (
                <b
                  className="sheet-note"
                  key={`${note.time}-${note.stringIdx}-${note.fret}-${index}`}
                  style={{
                    left: `${Math.min(98.5, Math.max(1.5, ((note.time - rowStart) / rowDuration) * 100))}%`,
                    top: `${stringTop(note.stringIdx)}%`,
                  }}
                >
                  {note.fret}
                </b>
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function stringTop(stringIdx: number): number {
  return 10 + stringIdx * 16
}

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.round(seconds % 60).toString().padStart(2, '0')
  return `${minutes}:${remainder}`
}
