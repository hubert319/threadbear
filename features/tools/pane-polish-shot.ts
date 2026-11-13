// Mac-native document and icon proof. Run only on a check host's desktop,
// through remote.sh --desk, after building the automation app. This brings
// its own window forward and captures only that window, including AppKit.
// TB_REAL_SCREEN=1 node features/tools/pane-polish-shot.ts <output folder>
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { GpuiDriver } from '../support/gpui.ts';
import { sleep } from '../support/driver.ts';
import { pane } from '../support/pane.ts';
import { sampleOffice } from '../support/office-document.ts';

if (process.platform !== 'darwin' || process.env.TB_REAL_SCREEN !== '1') throw new Error('Run on a check host desktop with TB_REAL_SCREEN=1');
const out = path.resolve(process.argv[2] ?? 'reports/pane-polish');
fs.mkdirSync(out, { recursive: true });
const fixture = path.join(out, 'fixture');
fs.mkdirSync(fixture, { recursive: true });
const document = sampleOffice(fixture);
// Distinct coloured pictures make a fallback symbol clear in the screenshot.
execFileSync('python3', ['-c', `import struct, zlib, sys, pathlib
p = pathlib.Path(sys.argv[1])
def chunk(kind, data): return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
raw = b''.join(b'\\0'+b'\\x22\\x88\\xee\\xff'*32 for _ in range(32))
png = b'\\x89PNG\\r\\n\\x1a\\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',32,32,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b'')
icon = b'icp5'+struct.pack('>I',8+len(png))+png
(p/'Blue.icns').write_bytes(b'icns'+struct.pack('>I',8+len(icon))+icon)
stream = b'0.9 0.1 0.1 rg 0 0 128 128 re f 1 1 1 rg BT /F1 90 Tf 35 30 Td (P) Tj ET'
objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>', b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 128 128] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', b'<< /Length '+str(len(stream)).encode()+b' >>\\nstream\\n'+stream+b'\\nendstream']
pdf = b'%PDF-1.4\\n'; offsets = [0]
for n, obj in enumerate(objects,1): offsets.append(len(pdf)); pdf += str(n).encode()+b' 0 obj\\n'+obj+b'\\nendobj\\n'
start = len(pdf); pdf += b'xref\\n0 6\\n0000000000 65535 f \\n'+b''.join(('%010d 00000 n \\n'%o).encode() for o in offsets[1:])+b'trailer\\n<< /Size 6 /Root 1 0 R >>\\nstartxref\\n'+str(start).encode()+b'\\n%%EOF\\n'
(p/'Red.pdf').write_bytes(pdf)
`, fixture]);
const now = new Date().toISOString();
fs.writeFileSync(path.join(fixture, 'thread.json'), JSON.stringify({
  id: 'pane-preview-example', title: 'Document previews and patch icons', cwd: fixture,
  accountId: 'claude-main', provider: 'claude', permissionMode: 'full', status: 'idle', live: false,
  needsYou: false, createdAt: now, updatedAt: now, lastActivityAt: now, preview: '',
  panels: [
    ['app', 'Calculator application icon', '/System/Applications/Calculator.app'],
    ['icns', 'Blue icns icon', path.join(fixture, 'Blue.icns')],
    ['pdf', 'Red PDF icon', path.join(fixture, 'Red.pdf')],
  ].map(([id, title, iconFile]) => ({ id: `example.${id}`, title, iconFile, icon: 'square.dashed', kind: 'list', patch: 'example' })),
}));
fs.writeFileSync(path.join(fixture, 'events.ndjson'), '');
process.env.TB_MOCK_FIXTURES = fixture;
process.env.TB_APPEARANCE = 'dark';
const app = new GpuiDriver();
try {
  await app.start();
  for (let i = 0; i < 200 && (await app.dump()).connection !== 'connected'; i++) await sleep(50);
  await app.do({ cmd: 'open', id: 'pane-preview-example' });
  await app.do({ cmd: 'preview', path: document });
  let shown = false;
  for (let i = 0; i < 300; i++) {
    const preview = pane(await app.dump());
    if (preview?.previewKind === 'quickLook' && preview.previewText) { shown = true; break; }
    await sleep(100);
  }
  if (!shown) throw new Error('Quick Look did not draw the Office document');
  await app.do({ cmd: 'front' });
  await sleep(800);
  const geometry = await app.do({ cmd: 'window' });
  const number = /^ok ([0-9]+) /.exec(geometry)?.[1];
  if (!number) throw new Error(`No native window id: ${geometry}`);
  execFileSync('screencapture', ['-x', '-o', `-l${number}`, path.join(out, 'office-and-icons.png')]);
  fs.writeFileSync(path.join(out, 'dump.json'), JSON.stringify(await app.dump(), null, 2));
  console.log(path.join(out, 'office-and-icons.png'));
} finally {
  await app.stop();
}
