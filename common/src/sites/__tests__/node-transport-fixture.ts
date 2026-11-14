import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

/** A real child-process boundary that refuses source in argv, then executes the
 * exact stdin program with Node. The production generator is never stubbed. */
export async function withNodeStdinProbe<T>(
  root: string,
  run: () => Promise<T>,
) {
  const node = execFileSync('node', ['-p', 'process.execPath'], {
    encoding: 'utf8',
  }).trim()
  const bin = join(root, 'transport-bin')
  const report = join(root, 'transport.jsonl')
  await mkdir(bin)
  await writeFile(
    join(bin, 'node'),
    `#!${node}
const {spawn} = require('node:child_process');
const {appendFileSync} = require('node:fs');
const args = process.argv.slice(2);
if (JSON.stringify(args) !== JSON.stringify(['--input-type=module', '-'])) {
  console.error('Preparation source must use stdin, never argv'); process.exit(42);
}
const chunks=[];
process.stdin.on('data', chunk=>chunks.push(chunk));
process.stdin.on('end', ()=>{
  const source=Buffer.concat(chunks);
  appendFileSync(${JSON.stringify(report)}, JSON.stringify({args,bytes:source.byteLength})+'\\n');
  const child=spawn(${JSON.stringify(node)},args,{stdio:['pipe','inherit','inherit']});
  child.stdin.on('error',()=>{});
  child.on('error',()=>{process.exitCode=1});
  child.on('close',code=>{process.exitCode=code??1});
  child.stdin.end(source);
});
`,
    { mode: 0o755 },
  )
  const previousPath = process.env.PATH
  try {
    process.env.PATH = bin + delimiter + (previousPath ?? '')
    const result = await run()
    const records = (await readFile(report, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { args: string[]; bytes: number })
    return { result, records }
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
  }
}
