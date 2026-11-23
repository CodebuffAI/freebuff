import { expect, test } from 'bun:test'
import { formulaSafeCell } from './export-safe'

// A shared sheet's text cell can carry an editor's or an agent's `=HYPERLINK(...)` into the
// reader's spreadsheet app on export: every exported text cell that would run is defused.
test('formula-looking text gets a leading apostrophe; ordinary text is unchanged', () => {
  for (const risky of ['=1+1', '+cmd', '-2+3', '@SUM(A1)', '\t=x', '\r=x', '  =HYPERLINK("x")', '﻿=x'])
    expect(formulaSafeCell(risky)).toBe(`'${risky}`)
  for (const plain of ['hello', 'a=b', '', '5 - 3', "'already"]) expect(formulaSafeCell(plain)).toBe(plain)
})
