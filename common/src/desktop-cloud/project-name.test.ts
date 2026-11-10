import { describe, expect, test } from 'bun:test'
import { isUntitledProjectName, nextUntitledProjectName, projectNameFromPrompt } from './project-name'

describe('automatic project names', () => {
  test('starts with Untitled and increments after the highest existing number', () => {
    expect(nextUntitledProjectName([])).toBe('Untitled')
    expect(nextUntitledProjectName(['Untitled'])).toBe('Untitled 2')
    expect(nextUntitledProjectName(['Untitled 2', 'Untitled', 'Untitled 9'])).toBe('Untitled 10')
  })

  test('does not reuse gaps or depend on catalog ordering', () => {
    expect(nextUntitledProjectName(['Untitled 5', 'Untitled 2'])).toBe('Untitled 6')
  })

  test('matches case and surrounding whitespace without counting other titles', () => {
    expect(nextUntitledProjectName([
      null, undefined, 'My project', 'Untitled notes', 'Untitled 0',
      'Untitled 02', 'Untitled -3', 'Untitled 2.5', 'Untitled 1e3',
      'Untitled 99999999999999999999999', ' untitled 3 ',
    ])).toBe('Untitled 4')
  })
})


describe('projectNameFromPrompt', () => {
  test('names what the first message asks to build', () => {
    expect(projectNameFromPrompt('Make a classic Snake game I can play in the browser with the arrow keys.')).toBe('Classic Snake Game')
    expect(projectNameFromPrompt('Build me a modern personal website with a home page.')).toBe('Modern Personal Website')
    expect(projectNameFromPrompt('Build a simple expense tracker where I can add expenses')).toBe('Expense Tracker')
    expect(projectNameFromPrompt('can you please create a todo app for my team')).toBe('Todo App')
    expect(projectNameFromPrompt("I'd like to build a Discord bot that posts the weather")).toBe('Discord Bot')
    expect(projectNameFromPrompt('fix the login page')).toBe('Fix the Login Page')
    expect(projectNameFromPrompt('hello')).toBe('Hello')
    expect(projectNameFromPrompt('A landing page for my SaaS startup')).toBe('Landing Page')
  })
  test('no words, no name', () => {
    expect(projectNameFromPrompt('   ')).toBeNull()
    expect(projectNameFromPrompt('!!!')).toBeNull()
  })
  test('stays short', () => {
    expect(projectNameFromPrompt('Supercalifragilisticexpialidocious-extraordinarily-long-hyphenated-thing')!.length).toBeLessThanOrEqual(40)
  })
})

test('isUntitledProjectName', () => {
  expect(isUntitledProjectName('Untitled')).toBe(true)
  expect(isUntitledProjectName('Untitled 3')).toBe(true)
  expect(isUntitledProjectName('Untitled game')).toBe(false)
  expect(isUntitledProjectName('Snake Game')).toBe(false)
})
