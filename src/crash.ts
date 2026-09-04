// Crash screen: when drawing (or anything else) throws, show what happened
// instead of silently dying. The render loop keeps running; the offending
// live stroke is dropped so the canvas stays usable.

let el: HTMLElement | null = null;
let lastMsg = '';
let lastAt = 0;
const recent: string[] = [];

function build() {
  el = document.createElement('div');
  el.className = 'crash hidden';
  el.innerHTML = `
    <div class="crash-box">
      <div class="crash-head">Something broke while drawing</div>
      <pre class="crash-msg"></pre>
      <div class="crash-actions">
        <button data-act="continue" class="crash-primary">Continue</button>
        <button data-act="copy">Copy report</button>
        <button data-act="reload">Reload</button>
      </div>
      <div class="crash-hint">Your zine is saved as of the last change. Continue drops the stroke that failed.</div>
    </div>`;
  document.body.appendChild(el);
  el.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest('button')?.dataset.act;
    if (act === 'continue') el!.classList.add('hidden');
    if (act === 'reload') location.reload();
    if (act === 'copy') {
      navigator.clipboard?.writeText(report()).then(
        () => { (el!.querySelector('[data-act="copy"]') as HTMLElement).textContent = 'Copied'; },
        () => {},
      );
    }
  });
}

function report(): string {
  return [
    `InfiniZine crash report — ${new Date().toISOString()}`,
    `UA: ${navigator.userAgent}`,
    `Screen: ${screen.width}×${screen.height} @${devicePixelRatio}`,
    '',
    ...recent,
  ].join('\n');
}

export function reportCrash(where: string, err: unknown) {
  const e = err as { message?: string; stack?: string } | undefined;
  const msg = `${where}: ${e?.message ?? String(err)}`;
  const stack = (e?.stack ?? '').split('\n').slice(0, 8).join('\n');
  recent.unshift(`[${new Date().toLocaleTimeString()}] ${msg}\n${stack}`);
  if (recent.length > 5) recent.pop();
  console.error('[InfiniZine]', where, err);
  // the same error firing every frame must not re-open the box each time
  const now = performance.now();
  if (msg === lastMsg && now - lastAt < 3000) return;
  lastMsg = msg; lastAt = now;
  if (!el) build();
  (el!.querySelector('.crash-msg') as HTMLElement).textContent = `${msg}\n\n${stack}`;
  (el!.querySelector('[data-act="copy"]') as HTMLElement).textContent = 'Copy report';
  el!.classList.remove('hidden');
}

export function installCrashScreen() {
  window.addEventListener('error', (e) => reportCrash('uncaught', e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => reportCrash('promise', e.reason));
}
