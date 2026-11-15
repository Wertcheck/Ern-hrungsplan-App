/** Inkrementeller Parser für Server-Sent-Events (`event: x\ndata: {json}\n\n`). Robust gegen beliebig zerstückelte Chunks. */
export interface SseEvent { event: string; data: unknown }

export class SseParser {
  private buf = ''
  push(chunk: string): SseEvent[] {
    // Ein „\r\n“ kann zwischen zwei Chunks getrennt ankommen: ein hängendes „\r“ wird bis zum nächsten Chunk zurückgehalten.
    this.buf += chunk
    const hold = this.buf.endsWith('\r') ? '\r' : ''
    this.buf = (hold ? this.buf.slice(0, -1) : this.buf).replace(/\r\n/g, '\n') + hold
    const out: SseEvent[] = []
    let i: number
    while ((i = this.buf.indexOf('\n\n')) >= 0) {
      const block = this.buf.slice(0, i); this.buf = this.buf.slice(i + 2)
      let event = 'message'; const data: string[] = []
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      }
      if (!data.length) continue
      try { out.push({ event, data: JSON.parse(data.join('\n')) }) } catch { out.push({ event: 'parse_error', data: null }) }
    }
    return out
  }
}
