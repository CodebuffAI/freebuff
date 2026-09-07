import { describe, expect, it } from 'bun:test'

import { pluralize, truncateStringWithMessage } from '../string'

describe('pluralize', () => {
  it('should handle singular and plural cases correctly', () => {
    expect(pluralize(1, 'test')).toBe('1 test')
    expect(pluralize(0, 'test')).toBe('0 tests')
    expect(pluralize(2, 'test')).toBe('2 tests')
  })

  it('should handle words ending in y', () => {
    expect(pluralize(1, 'city')).toBe('1 city')
    expect(pluralize(2, 'city')).toBe('2 cities')
    expect(pluralize(3, 'repository')).toBe('3 repositories')
  })

  it('should handle words ending in f/fe', () => {
    expect(pluralize(1, 'leaf')).toBe('1 leaf')
    expect(pluralize(2, 'leaf')).toBe('2 leaves')
    expect(pluralize(1, 'knife')).toBe('1 knife')
    expect(pluralize(2, 'knife')).toBe('2 knives')
    expect(pluralize(1, 'life')).toBe('1 life')
    expect(pluralize(3, 'life')).toBe('3 lives')
  })

  it('should handle words ending in s, sh, ch, x, z, o', () => {
    expect(pluralize(2, 'bus')).toBe('2 buses')
    expect(pluralize(2, 'box')).toBe('2 boxes')
    expect(pluralize(2, 'church')).toBe('2 churches')
    expect(pluralize(2, 'dish')).toBe('2 dishes')
  })

  it('should handle regular plurals', () => {
    expect(pluralize(1, 'agent')).toBe('1 agent')
    expect(pluralize(0, 'agent')).toBe('0 agents')
    expect(pluralize(5, 'member')).toBe('5 members')
    expect(pluralize(10, 'invitation')).toBe('10 invitations')
  })

  it('should return only the word when includeCount is false', () => {
    expect(pluralize(1, 'answer', { includeCount: false })).toBe('answer')
    expect(pluralize(2, 'answer', { includeCount: false })).toBe('answers')
    expect(pluralize(1, 'question', { includeCount: false })).toBe('question')
    expect(pluralize(5, 'question', { includeCount: false })).toBe('questions')
    expect(pluralize(2, 'city', { includeCount: false })).toBe('cities')
    expect(pluralize(2, 'leaf', { includeCount: false })).toBe('leaves')
  })

  // Tech/CS irregular plurals (truly irregular, no derivable pattern)
  it('should handle truly irregular plurals', () => {
    // Common irregulars
    expect(pluralize(2, 'person')).toBe('2 people')
    expect(pluralize(2, 'child')).toBe('2 children')
    expect(pluralize(2, 'mouse')).toBe('2 mice')
    
    // -ex/-ix → -ices (no reliable rule, must be hardcoded)
    expect(pluralize(2, 'index')).toBe('2 indices')
    expect(pluralize(2, 'vertex')).toBe('2 vertices')
    expect(pluralize(2, 'matrix')).toBe('2 matrices')
    expect(pluralize(2, 'appendix')).toBe('2 appendices')
    
    // Latin -um → -a
    expect(pluralize(2, 'datum')).toBe('2 data')
    expect(pluralize(2, 'medium')).toBe('2 media')
    expect(pluralize(2, 'criterion')).toBe('2 criteria')
    expect(pluralize(2, 'phenomenon')).toBe('2 phenomena')
  })

  // Derived rule: -sis → -ses
  it('should handle -sis → -ses by rule', () => {
    expect(pluralize(2, 'analysis')).toBe('2 analyses')
    expect(pluralize(2, 'basis')).toBe('2 bases')
    expect(pluralize(2, 'hypothesis')).toBe('2 hypotheses')
    expect(pluralize(2, 'thesis')).toBe('2 theses')
    expect(pluralize(2, 'parenthesis')).toBe('2 parentheses')
    expect(pluralize(2, 'synopsis')).toBe('2 synopses')
    expect(pluralize(2, 'crisis')).toBe('2 crises')
    expect(pluralize(2, 'diagnosis')).toBe('2 diagnoses')
    expect(pluralize(2, 'ellipsis')).toBe('2 ellipses')
    // Any new -sis word should work without adding to list
    expect(pluralize(2, 'oasis')).toBe('2 oases')
    expect(pluralize(2, 'genesis')).toBe('2 geneses')
  })

  // Derived rule: -xis → -xes
  it('should handle -xis → -xes by rule', () => {
    expect(pluralize(2, 'axis')).toBe('2 axes')
    // Any new -xis word should work without adding to list
    expect(pluralize(2, 'praxis')).toBe('2 praxes')
  })

  // Derived rule: -ware stays unchanged
  it('should handle -ware words staying unchanged by rule', () => {
    expect(pluralize(2, 'software')).toBe('2 software')
    expect(pluralize(2, 'hardware')).toBe('2 hardware')
    expect(pluralize(2, 'firmware')).toBe('2 firmware')
    expect(pluralize(2, 'malware')).toBe('2 malware')
    expect(pluralize(2, 'middleware')).toBe('2 middleware')
    expect(pluralize(2, 'freeware')).toBe('2 freeware')
    expect(pluralize(2, 'shareware')).toBe('2 shareware')
    // Any new -ware word should work without adding to list
    expect(pluralize(2, 'spyware')).toBe('2 spyware')
    expect(pluralize(2, 'bloatware')).toBe('2 bloatware')
  })

  // Derived rule: -ics stays unchanged
  it('should handle -ics words staying unchanged by rule', () => {
    expect(pluralize(2, 'analytics')).toBe('2 analytics')
    expect(pluralize(2, 'graphics')).toBe('2 graphics')
    expect(pluralize(2, 'physics')).toBe('2 physics')
    expect(pluralize(2, 'mathematics')).toBe('2 mathematics')
    expect(pluralize(2, 'statistics')).toBe('2 statistics')
    expect(pluralize(2, 'logistics')).toBe('2 logistics')
    expect(pluralize(2, 'economics')).toBe('2 economics')
    // Any new -ics word should work without adding to list
    expect(pluralize(2, 'semantics')).toBe('2 semantics')
    expect(pluralize(2, 'heuristics')).toBe('2 heuristics')
  })

  it('should handle other unchanging plurals', () => {
    // Data terms (hardcoded because 'data' is special case)
    expect(pluralize(2, 'data')).toBe('2 data')
    expect(pluralize(2, 'metadata')).toBe('2 metadata')
    expect(pluralize(2, 'feedback')).toBe('2 feedback')
    
    // Other words ending in -s that don't change
    expect(pluralize(2, 'series')).toBe('2 series')
    expect(pluralize(2, 'chassis')).toBe('2 chassis')
    expect(pluralize(2, 'species')).toBe('2 species')
  })

  it('should handle tech -o endings', () => {
    // Words that add -es (default for -o)
    expect(pluralize(2, 'hero')).toBe('2 heroes')
    expect(pluralize(2, 'echo')).toBe('2 echoes')
    expect(pluralize(2, 'veto')).toBe('2 vetoes')
    
    // Tech terms that just add -s
    expect(pluralize(2, 'photo')).toBe('2 photos')
    expect(pluralize(2, 'video')).toBe('2 videos')
    expect(pluralize(2, 'audio')).toBe('2 audios')
    expect(pluralize(2, 'logo')).toBe('2 logos')
    expect(pluralize(2, 'demo')).toBe('2 demos')
    expect(pluralize(2, 'repo')).toBe('2 repos')
    expect(pluralize(2, 'memo')).toBe('2 memos')
    expect(pluralize(2, 'typo')).toBe('2 typos')
    expect(pluralize(2, 'intro')).toBe('2 intros')
    expect(pluralize(2, 'macro')).toBe('2 macros')
    expect(pluralize(2, 'scenario')).toBe('2 scenarios')
    expect(pluralize(2, 'portfolio')).toBe('2 portfolios')
    expect(pluralize(2, 'ratio')).toBe('2 ratios')
    expect(pluralize(2, 'zero')).toBe('2 zeros')
    expect(pluralize(2, 'silo')).toBe('2 silos') // data silos
  })

  it('should handle -f/-fe endings', () => {
    // Words that change -f to -ves (default behavior)
    expect(pluralize(2, 'half')).toBe('2 halves')
    expect(pluralize(2, 'shelf')).toBe('2 shelves')
    expect(pluralize(2, 'self')).toBe('2 selves')
    expect(pluralize(2, 'leaf')).toBe('2 leaves')
    
    // -fe to -ves
    expect(pluralize(2, 'knife')).toBe('2 knives')
    expect(pluralize(2, 'life')).toBe('2 lives')
    
    // Tech/design terms that just add -s
    expect(pluralize(2, 'proof')).toBe('2 proofs') // mathematical proofs
    expect(pluralize(2, 'brief')).toBe('2 briefs') // design briefs
    expect(pluralize(2, 'chief')).toBe('2 chiefs') // tech leads
    expect(pluralize(2, 'staff')).toBe('2 staffs')
    expect(pluralize(2, 'serif')).toBe('2 serifs') // font serifs
    expect(pluralize(2, 'motif')).toBe('2 motifs') // design motifs
    expect(pluralize(2, 'gif')).toBe('2 gifs')
    expect(pluralize(2, 'pdf')).toBe('2 pdfs')
  })

  it('should handle words ending in -y with vowel before', () => {
    // vowel + y -> just add -s
    expect(pluralize(2, 'key')).toBe('2 keys')
    expect(pluralize(2, 'monkey')).toBe('2 monkeys')
    expect(pluralize(2, 'toy')).toBe('2 toys')
    expect(pluralize(2, 'boy')).toBe('2 boys')
    expect(pluralize(2, 'day')).toBe('2 days')
    expect(pluralize(2, 'way')).toBe('2 ways')
    expect(pluralize(2, 'tray')).toBe('2 trays')
    expect(pluralize(2, 'valley')).toBe('2 valleys')
    expect(pluralize(2, 'donkey')).toBe('2 donkeys')
    expect(pluralize(2, 'essay')).toBe('2 essays')
  })

  it('should handle words ending in -ful', () => {
    expect(pluralize(2, 'cupful')).toBe('2 cupfuls')
    expect(pluralize(2, 'handful')).toBe('2 handfuls')
    expect(pluralize(2, 'spoonful')).toBe('2 spoonfuls')
  })

  it('should handle words already ending in -s', () => {
    expect(pluralize(2, 'bus')).toBe('2 buses')
    expect(pluralize(2, 'lens')).toBe('2 lenses')
    expect(pluralize(2, 'gas')).toBe('2 gases')
  })

  it('should handle words ending in -z', () => {
    // Single z doubles
    expect(pluralize(2, 'quiz')).toBe('2 quizzes')
    expect(pluralize(2, 'fez')).toBe('2 fezzes')
    // Double z just adds -es
    expect(pluralize(2, 'buzz')).toBe('2 buzzes')
    expect(pluralize(2, 'fizz')).toBe('2 fizzes')
  })

  it('should handle common tech terms', () => {
    // Regular tech plurals
    expect(pluralize(2, 'schema')).toBe('2 schemas')
    expect(pluralize(2, 'API')).toBe('2 APIs')
    expect(pluralize(2, 'SDK')).toBe('2 SDKs')
    expect(pluralize(2, 'URL')).toBe('2 URLs')
    expect(pluralize(2, 'CLI')).toBe('2 CLIs')
    expect(pluralize(2, 'bug')).toBe('2 bugs')
    expect(pluralize(2, 'feature')).toBe('2 features')
    expect(pluralize(2, 'commit')).toBe('2 commits')
    expect(pluralize(2, 'branch')).toBe('2 branches')
    expect(pluralize(2, 'merge')).toBe('2 merges')
    expect(pluralize(2, 'deploy')).toBe('2 deploys')
    expect(pluralize(2, 'release')).toBe('2 releases')
    expect(pluralize(2, 'sprint')).toBe('2 sprints')
    expect(pluralize(2, 'ticket')).toBe('2 tickets')
    expect(pluralize(2, 'endpoint')).toBe('2 endpoints')
    expect(pluralize(2, 'webhook')).toBe('2 webhooks')
    expect(pluralize(2, 'callback')).toBe('2 callbacks')
    expect(pluralize(2, 'payload')).toBe('2 payloads')
    expect(pluralize(2, 'token')).toBe('2 tokens')
    expect(pluralize(2, 'query')).toBe('2 queries')
    expect(pluralize(2, 'dependency')).toBe('2 dependencies')
  })

  describe('truncateStringWithMessage', () => {
    it('should return original string when within maxLength', () => {
      const result = truncateStringWithMessage({
        str: 'Short',
        maxLength: 100
      })
      expect(result).toBe('Short')
    })

    it('should handle empty string', () => {
      const result = truncateStringWithMessage({
        str: '',
        maxLength: 10
      })
      expect(result).toBe('')
    })

    it('should truncate from END mode', () => {
      const result = truncateStringWithMessage({
        str: 'This is a very long string that needs to be truncated for testing purposes',
        maxLength: 50,
        remove: 'END'
      })
      expect(result).toContain('TRUNCATED DUE TO LENGTH')
      expect(result.startsWith('This is')).toBe(true)
    })

    it('should truncate from START mode', () => {
      const result = truncateStringWithMessage({
        str: 'This is a very long string that needs to be truncated for testing purposes',
        maxLength: 50,
        remove: 'START'
      })
      expect(result).toContain('TRUNCATED DUE TO LENGTH')
      expect(result.endsWith('purposes')).toBe(true)
    })

    it('should truncate from MIDDLE mode', () => {
      const result = truncateStringWithMessage({
        str: 'This is a very long string that needs to be truncated for testing purposes',
        maxLength: 50,
        remove: 'MIDDLE'
      })
      expect(result).toContain('TRUNCATED DUE TO LENGTH')
      expect(result.startsWith('This is')).toBe(true)
      expect(result.endsWith('purposes')).toBe(true)
    })

    it('should handle negative available length for END mode', () => {
      const result = truncateStringWithMessage({
        str: 'Hello world',
        maxLength: 5,
        remove: 'END'
      })
      expect(result).toBe('\n[TRUNCATED DUE TO LENGTH...]')
    })

    it('should handle negative available length for START mode', () => {
      const result = truncateStringWithMessage({
        str: 'Hello world',
        maxLength: 5,
        remove: 'START'
      })
      expect(result).toBe('[...TRUNCATED DUE TO LENGTH]\n')
    })

    it('should handle negative available length for MIDDLE mode', () => {
      const result = truncateStringWithMessage({
        str: 'Hello world',
        maxLength: 5,
        remove: 'MIDDLE'
      })
      expect(result).toContain('TRUNCATED DUE TO LENGTH')
    })

    it('should use custom message when provided', () => {
      const result = truncateStringWithMessage({
        str: 'This is a very long string that needs to be truncated for testing purposes',
        maxLength: 50,
        message: 'CUSTOM MSG'
      })
      expect(result).toContain('CUSTOM MSG')
      expect(result.startsWith('This is')).toBe(true)
    })
  })
})

