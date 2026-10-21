import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { nextPreviewInputSequence } from './native-preview-storage';

// The canvas only decodes simulator video. It never renders application components.
export function NativePreviewVideo({ merchant, session, platform = 'ios', implementation = 'native', feedbackContainer }: { merchant: string; session: string; platform?: 'ios' | 'android'; implementation?: 'native' | 'react-native'; feedbackContainer?: HTMLElement | null }) {
  const label = platform === 'android' ? 'Android' : 'iOS';
  const canvas = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState(`Starting ${label} ${platform === 'android' ? 'Emulator' : 'Simulator'}…`);
  const [error, setError] = useState('');
  const live = useRef(false);
  const sequence = useRef(0);
  const epoch = useRef(0);
  const pending = useRef(0);
  const queue = useRef(Promise.resolve());
  const gesture = useRef<{ x: number; y: number; at: number }>();
  const base = `/api/v1/merchants/${encodeURIComponent(merchant)}/app-preview/sessions/${encodeURIComponent(session)}`;
  const lifetime = useRef<AbortController>();

  function send(data: Record<string, unknown>) {
    if (!live.current || pending.current >= 16) { setError('Preview is busy or disconnected. Try again when video resumes.'); return; }
    pending.current++;
    const generation = epoch.current;
    sequence.current = nextPreviewInputSequence(`rocento.preview-input:${merchant}:${session}`, sequence.current);
    const payload = { ...data, sequence: sequence.current };
    return queue.current = queue.current.then(async () => {
      if (!live.current || lifetime.current?.signal.aborted || generation !== epoch.current) return;
      const response = await fetch(`${base}/input`, { method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Commerce-Request': '1' }, body: JSON.stringify(payload), signal: lifetime.current?.signal });
      if (!response.ok) throw new Error('Input could not be applied. It was not retried.');
      setError('');
    }).catch(e => { if (!lifetime.current?.signal.aborted) setError(e.message); })
      .finally(() => { pending.current--; });
  }
  useEffect(() => {
    const life = new AbortController(); lifetime.current = life;
    let connection: AbortController | undefined;
    let retry: ReturnType<typeof setTimeout>;
    const clear = () => { epoch.current++; live.current = false; const c = canvas.current; if (c) { c.dataset.live = 'false'; c.getContext('2d')?.clearRect(0, 0, c.width, c.height); } };
    async function connect() {
      const attempt = connection = new AbortController();
      let lastBytes = performance.now(), lastFrame = performance.now(), count = 0, sampled = performance.now();
      let newest: Uint8Array<ArrayBuffer> | undefined;
      let bitmap: ImageBitmap | undefined;
      let decoding = false;
      let paint: number | undefined;
      let clock: { capture: number; received: number } | undefined;
      let bitmapCapture: number | undefined;
      let stale = false;
      function capturedAt(bytes: Uint8Array) {
        return bytes.length >= 18 && bytes[2] === 255 && bytes[3] === 254 && bytes[4] === 0 && bytes[5] === 14
          && bytes[6] === 82 && bytes[7] === 79 && bytes[8] === 67 && bytes[9] === 84
          ? new DataView(bytes.buffer, bytes.byteOffset + 10, 8).getFloat64(0) : undefined;
      }
      function lag(capture: number | undefined) {
        if (capture === undefined || !Number.isFinite(capture)) return 0;
        clock ??= { capture, received: performance.now() };
        return Math.max(0, performance.now() - clock.received - (capture - clock.capture));
      }
      const ended = () => life.signal.aborted || attempt.signal.aborted;
      function present() {
        paint = undefined;
        if (ended()) { bitmap?.close(); bitmap = undefined; return; }
        const frame = bitmap; bitmap = undefined;
        if (!frame) return;
        const age = lag(bitmapCapture);
        if (age > 1200) { frame.close(); stale = true; attempt.abort(); return; }
        const c = canvas.current;
        if (c) {
          if (c.width !== frame.width || c.height !== frame.height) {
            c.width = frame.width; c.height = frame.height;
            c.style.setProperty('--native-aspect', String(frame.width / frame.height));
          }
          c.getContext('2d')?.drawImage(frame, 0, 0); c.dataset.live = 'true';
          // Count presented frames, not a burst of decoded historical frames.
          c.dataset.frames = String(Number(c.dataset.frames || 0) + 1);
          c.dataset.transportLagMs = String(Math.round(age));
        }
        frame.close(); if (!live.current) setStatus(`Live ${label} video`);
        live.current = true; lastFrame = performance.now(); count++;
        if (lastFrame - sampled >= 1000) {
          setStatus(`Live ${label} video · ${Math.round(count * 1000 / (lastFrame - sampled))} fps`);
          sampled = lastFrame; count = 0;
        }
      }
      async function decodeLatest() {
        if (decoding) return;
        decoding = true;
        try {
          while (newest && !ended()) {
            const bytes = newest; newest = undefined;
            const capture = capturedAt(bytes);
            if (lag(capture) > 1200) { stale = true; attempt.abort(); return; }
            const frame = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
            if (ended()) { frame.close(); return; }
            bitmap?.close(); bitmap = frame; bitmapCapture = capture;
            if (paint === undefined) paint = requestAnimationFrame(present);
          }
        } catch { attempt.abort(); }
        finally { decoding = false; }
      }
      const watchdog = setInterval(() => {
        if (performance.now() - lastBytes > 6000 || (live.current && performance.now() - lastFrame > 3000)) connection?.abort();
      }, 1000);
      try {
        const response = await fetch(`${base}/video`, { credentials: 'include', cache: 'no-store', signal: connection.signal });
        if (response.status === 401 || response.status === 403 || response.status === 404) {
          clear(); setStatus('Preview session ended. Start a new preview.'); return;
        }
        if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('application/x-rocento-mjpeg')) throw new Error('Video unavailable');
        const reader = response.body.getReader();
        let buffer = new Uint8Array(0);
        while (!life.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) throw new Error('Video disconnected');
          lastBytes = performance.now();
          const joined = new Uint8Array(buffer.length + value.length); joined.set(buffer); joined.set(value, buffer.length); buffer = joined;
          if (buffer.length > 4 * 1024 * 1024) throw new Error('Video buffer exceeded');
          while (buffer.length >= 4) {
            const size = new DataView(buffer.buffer, buffer.byteOffset, 4).getUint32(0, true);
            if (size > 2 * 1024 * 1024) throw new Error('Invalid video frame');
            if (buffer.length < size + 4) break;
            const bytes = buffer.slice(4, size + 4); buffer = buffer.slice(size + 4);
            if (!size) continue; // Worker heartbeat while the native screen is starting.
            newest = bytes;

          }
          // Reading never waits for decode/paint: retain one newest complete JPEG,
          // discard history after stalls, and keep any partial frame for the next read.
          void decodeLatest();
        }
      } catch {
        clear();
        if (!life.signal.aborted) { setStatus('Video disconnected. Reconnecting…'); retry = setTimeout(connect, stale ? 100 : 1000); }
      } finally {
        clearInterval(watchdog); attempt.abort(); newest = undefined;
        if (paint !== undefined) cancelAnimationFrame(paint);
        bitmap?.close(); bitmap = undefined;
      }
    }
    const offline = () => { connection?.abort(); clear(); setStatus('Video disconnected. Reconnecting…'); };
    window.addEventListener('offline', offline);
    void connect();
    return () => { window.removeEventListener('offline', offline); life.abort(); connection?.abort(); clearTimeout(retry); clear(); };
  }, [base]);

  function point(clientX: number, clientY: number) {
    const r = canvas.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (clientY - r.top) / r.height)) };
  }
  useEffect(() => {
    const c = canvas.current; if (!c) return;
    let dx = 0, dy = 0, generation = epoch.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const flush = async () => {
      timer = undefined;
      if (stopped || !live.current || generation !== epoch.current) { dx = dy = 0; running = false; return; }
      // Coalesce trackpad events and allow only one native swipe in flight.
      const x = Math.max(-.35, Math.min(.35, dx));
      const y = Math.max(-.35, Math.min(.35, dy));
      dx = dy = 0;
      if (x || y) await send({ kind: 'swipe', x: .5, y: .5, endX: .5 - x, endY: .5 - y, duration: .12 });
      if (!stopped && (dx || dy)) timer = setTimeout(flush, 16);
      else running = false;
    };
    let running = false;
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); event.stopPropagation();
      if (!live.current) return;
      if (generation !== epoch.current) { dx = dy = 0; generation = epoch.current; }
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? c.clientHeight : 1;
      dx = Math.max(-.35, Math.min(.35, dx + event.deltaX * unit / c.clientWidth));
      dy = Math.max(-.35, Math.min(.35, dy + event.deltaY * unit / c.clientHeight));
      if (!running) { running = true; timer = setTimeout(flush, 32); }
    };
    c.addEventListener('wheel', wheel, { passive: false });
    return () => { stopped = true; clearTimeout(timer); c.removeEventListener('wheel', wheel); };
  }, [base]);

  const feedback = <>
    <p role="status" className="ms-native-video-status">{status}</p>
    {error && <p role="alert">{error}</p>}
  </>;
  return <div className="ms-native-stream">
    <div className="ms-native-viewport"><canvas ref={canvas} width={603} height={1311} tabIndex={0} role="application"
      aria-label={implementation === 'react-native' ? `Interactive React Native ${label} preview` : platform === 'android' ? 'Interactive Android preview' : 'Interactive SwiftUI iOS preview'} aria-describedby="native-input-help" data-live="false" data-session={session}
      onPointerDown={e => { if (!live.current || e.button !== 0) return; e.currentTarget.focus(); e.currentTarget.setPointerCapture(e.pointerId); gesture.current = { ...point(e.clientX, e.clientY), at: performance.now() }; }}
      onPointerCancel={() => { gesture.current = undefined; }}
      onPointerUp={e => {
        const start = gesture.current; gesture.current = undefined; if (!start) return;
        const end = point(e.clientX, e.clientY);
        if (Math.hypot(end.x - start.x, end.y - start.y) < .015) send({ kind: 'tap', x: end.x, y: end.y });
        else send({ kind: 'swipe', x: start.x, y: start.y, endX: end.x, endY: end.y, duration: Math.max(.05, Math.min(1.5, (performance.now() - start.at) / 1000)) });
      }}
      onKeyDown={e => {
        if (e.ctrlKey || e.metaKey || e.altKey || e.isDefaultPrevented()) return;
        if (['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Delete'].includes(e.key)) {
          // Let Tab leave the preview so keyboard focus is never trapped.
          if (e.key === 'Tab') return;
          e.preventDefault(); send({ kind: 'key', key: e.key });
        } else if (e.key.length === 1 && /^[\x20-\x7e]$/.test(e.key)) { e.preventDefault(); send({ kind: 'text', text: e.key }); }
      }} />
    </div>
    {feedbackContainer === undefined ? feedback : feedbackContainer && createPortal(feedback, feedbackContainer)}
  </div>;
}
