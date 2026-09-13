import { describe, test, expect } from 'bun:test'

import { filterSlashCommands } from '../use-suggestion-engine'

import type { SlashCommand } from '../../data/slash-commands'

const commands: SlashCommand[] = [
  { id: 'help', label: 'Help', description: 'Show help' },
  { id: 'compact', label: 'Compact history', description: 'Shrink the transcript', aliases: ['squash'] },
  { id: 'agent', label: 'Switch agent', description: 'Pick a different agent (helpful for delegation)' },
]

describe('filterSlashCommands', () => {
  test('an empty query returns every command unfiltered', () => {
    expect(filterSlashCommands(commands, '')).toBe(commands)
  })

  test('a prefix match on id wins a slot over a later substring-only match', () => {
    // "co" is a prefix of "compact" and also a substring of nothing else here,
    // so it should appear via the prefix pass.
    const result = filterSlashCommands(commands, 'co')
    expect(result.map((c) => c.id)).toEqual(['compact'])
  })

  test('a substring-only match on id is still found when no command has it as a prefix', () => {
    // "pact" is a substring of "compact" but not a prefix of any command id.
    const result = filterSlashCommands(commands, 'pact')
    expect(result.map((c) => c.id)).toEqual(['compact'])
  })

  test('a command is never returned twice when it matches more than one pass', () => {
    // "compact" matches its own id by both the prefix and the substring pass.
    const result = filterSlashCommands(commands, 'compact')
    expect(result.map((c) => c.id)).toEqual(['compact'])
  })

  test('a query can surface more than one command, each via a different pass', () => {
    // "help" is a prefix match on the help command's id, and — via "helpful" — a
    // substring match on agent's description.
    const result = filterSlashCommands(commands, 'help')
    expect(result.map((c) => c.id)).toEqual(['help', 'agent'])
  })

  test('an alias match on prefix or substring finds the command by its real id', () => {
    const prefixResult = filterSlashCommands(commands, 'squ')
    expect(prefixResult.map((c) => c.id)).toEqual(['compact'])

    const substringResult = filterSlashCommands(commands, 'uas')
    expect(substringResult.map((c) => c.id)).toEqual(['compact'])
  })

  test('a description-only substring match is found as the last resort', () => {
    // "delegation" appears only in agent's description, not its id/label/aliases.
    const result = filterSlashCommands(commands, 'delegation')
    expect(result.map((c) => c.id)).toEqual(['agent'])
    expect(result[0].labelHighlightIndices).toBeUndefined()
    const start = result[0].description.toLowerCase().indexOf('delegation')
    expect(result[0].descriptionHighlightIndices).toEqual(
      Array.from({ length: 'delegation'.length }, (_, i) => start + i),
    )
  })

  test('matching is case-insensitive', () => {
    expect(filterSlashCommands(commands, 'HELP').map((c) => c.id)).toEqual(['help', 'agent'])
  })

  test('no match returns an empty array', () => {
    expect(filterSlashCommands(commands, 'zzz')).toEqual([])
  })
})
