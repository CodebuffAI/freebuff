const readline = require('node:readline')

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line)
  if (request.command === 'silent') return
  if (request.command === 'malformed') {
    process.stdout.write(
      JSON.stringify({
        id: request.id,
        text: 12,
        applied: true,
        reason: 'ok',
      }) + '\n',
    )
    return
  }
  if (request.command === 'wrong-id') {
    process.stdout.write(
      JSON.stringify({
        id: request.id + 1,
        text: 'wrong',
        applied: true,
        reason: 'ok',
      }) + '\n',
    )
    return
  }
  const delay = request.command === 'first' ? 30 : 0
  setTimeout(() => {
    process.stdout.write(
      JSON.stringify({
        id: request.id,
        text: `compressed:${request.output}`,
        applied: request.command !== 'not-applied',
        reason: 'ok',
      }) + '\n',
    )
  }, delay)
})
