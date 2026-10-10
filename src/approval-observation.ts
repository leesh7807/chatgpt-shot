import { chmodSync, existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { jobTelemetryPath } from './job-telemetry.js';
import type { ApprovalScreenshot } from './notion-approval-assist.js';

const uid = process.getuid?.();

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) throw new Error('Approval observation directory is not owner-controlled.');
  chmodSync(path, 0o700);
}

/** Stores explicitly requested approval-card screenshots under the private XDG cache. */
export class LocalApprovalObservationWriter {
  private sequence = 0;
  private readonly directory: string;

  constructor(private readonly jobId: string, root = join(dirname(jobTelemetryPath()), 'observations')) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)) throw new Error('Invalid approval observation Job ID.');
    this.directory = join(root, jobId);
  }

  write(screenshot: ApprovalScreenshot): string | undefined {
    try {
      if (screenshot.png.length > 12_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(screenshot.png)) return;
      const png = Buffer.from(screenshot.png, 'base64');
      if (png.length < 8 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return;
      ensurePrivateDirectory(dirname(this.directory));
      ensurePrivateDirectory(this.directory);
      const frame = screenshot.frame === 'before_click' ? 'before-click' : 'after-click';
      let name = '';
      let path = '';
      do {
        const sequence = String(++this.sequence).padStart(3, '0');
        if (existsSync(join(this.directory, `approval-${sequence}-before-click.png`))
          || existsSync(join(this.directory, `approval-${sequence}-after-click.png`))) continue;
        name = `approval-${sequence}-${frame}.png`;
        path = join(this.directory, name);
        try { writeFileSync(path, png, { mode: 0o600, flag: 'wx' }); }
        catch (error: any) { if (error?.code === 'EEXIST') continue; return; }
        break;
      } while (true);
      chmodSync(path, 0o600);
      const stat = lstatSync(path);
      if (!stat.isFile() || (uid !== undefined && stat.uid !== uid) || existsSync(path) && stat.isSymbolicLink()) return;
      return name;
    } catch {
      return;
    }
  }
}
