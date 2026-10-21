// End-to-end driver: sends one chat message to a running copilot, prints the stream,
// and answers approval cards automatically. Used to rehearse the demo.
//   node scripts/e2e.js "<message>" [--session ID] [--base URL] [--input KEY=VALUE] [--reject]
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const base = opt('--base', 'http://localhost:4100');
const session = opt('--session', 'e2e');
const reject = args.includes('--reject');
const inputs = Object.fromEntries(args.flatMap((a, i) => (a === '--input' ? [args[i + 1].split('=')] : [])));
const text = args.find((a, i) => !a.startsWith('--') && !['--session', '--base', '--input'].includes(args[i - 1]));

const res = await fetch(`${base}/api/session/${session}/events?after=${Number.MAX_SAFE_INTEGER - 1}`);
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
let started = false;
const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

setTimeout(async () => { started = true; const r = await post(`/api/session/${session}/chat`, { text }); if (!r.ok) { console.log('chat refused', r); process.exit(1); } }, 300);
const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const chunk = buf.slice(0, i);
    buf = buf.slice(i + 2);
    if (!chunk.startsWith('data:')) continue;
    const ev = JSON.parse(chunk.slice(5));
    if (!started) continue;
    switch (ev.type) {
      case 'delta': process.stdout.write(ev.text); break;
      case 'assistant_end': process.stdout.write('\n'); break;
      case 'tool_start': console.log(`[${ts()}] ▶ ${ev.tool} (${ev.risk}) ${JSON.stringify(ev.args).slice(0, 160)}`); break;
      case 'tool_progress': if (ev.status !== 'log') console.log(`   · ${ev.step} ${ev.status} ${ev.detail || ''}`); break;
      case 'tool_end': console.log(`[${ts()}] ${ev.ok ? '✓' : '✗'} ${ev.tool} ${ev.error || ''}${ev.ui === 'diagnosis' ? '\n' + ev.data.hypotheses.map((h) => `     #${h.rank} ${h.id} ${h.confidence}% :: ${h.evidence.join(' | ')}`).join('\n') : ''}${ev.ui === 'verify' ? ` => ${ev.data.verdict} ${JSON.stringify(ev.data.before)} -> ${JSON.stringify(ev.data.after)}` : ''}`); break;
      case 'approval': {
        console.log(`[${ts()}] ◆ APPROVAL ${ev.tool} risk=${ev.risk}: ${ev.card.summaryFa}${ev.card.blocked ? ` BLOCKED: ${ev.card.blocked.reasonFa}` : ''}`);
        const action = reject || ev.card.blocked ? 'reject' : 'approve';
        const vals = {};
        for (const inp of ev.card.inputs || []) vals[inp.key] = inputs[inp.key] ?? inp.prefill ?? '';
        await post(`/api/session/${session}/approvals/${ev.id}`, { action, inputs: vals });
        console.log(`   → ${action}`);
        break;
      }
      case 'error': console.log(`[${ts()}] ERROR ${ev.message}`); break;
      case 'llm_status': console.log(`[${ts()}] llm available=${ev.available} ${ev.reason || ''}`); break;
      case 'turn_end': console.log(`[${ts()}] turn end`); process.exit(0);
      default: break;
    }
  }
}
