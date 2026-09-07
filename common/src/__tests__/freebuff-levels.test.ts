import { describe, expect, it } from 'bun:test'

import {
  FREEBUFF_LEVELS,
  FREEBUFF_LEVEL_0,
  FREEBUFF_LEVEL_SESSION_CEILING,
  FREEBUFF_MAX_LEVEL,
  FREEBUFF_TRUST_COST_PER_PROMPT,
  FREEBUFF_TRUST_ALLOW_NEGATIVE,
  FREEBUFF_TRUST_MIN_BALANCE,
  levelForTrust,
  levelProgress,
  levelSessionBonus,
  nextLevelAfter,
} from '../constants/freebuff-levels'
import * as freebuffModels from '../constants/freebuff-models'
import {
  FREEBUFF_LIMITED_SESSION_LIMIT,
  FREEBUFF_PREMIUM_SESSION_LIMIT,
} from '../constants/freebuff-models'

describe('the ladder', () => {
  it('is strictly increasing in every axis that costs us money', () => {
    // `levelForTrust` scans and breaks on the first threshold above the
    // balance, so a mis-ordered row would silently cap everyone at that rung.
    for (let i = 1; i < FREEBUFF_LEVELS.length; i++) {
      const lower = FREEBUFF_LEVELS[i - 1]!
      const higher = FREEBUFF_LEVELS[i]!
      expect(higher.level).toBe(lower.level + 1)
      expect(higher.trustRequired).toBeGreaterThan(lower.trustRequired)
      expect(higher.trustPerEngagement).toBeGreaterThanOrEqual(
        lower.trustPerEngagement,
      )
      expect(higher.freeSessionsPerDay).toBeGreaterThanOrEqual(
        lower.freeSessionsPerDay,
      )
      expect(higher.premiumSessionsPerDay).toBeGreaterThanOrEqual(
        lower.premiumSessionsPerDay,
      )
    }
  })

  it('starts exactly where the flat session bases start', () => {
    // The load-bearing equality, and the one that makes shipping this safe:
    // `levelSessionBonus` is a DELTA against level 0, so level 0 disagreeing
    // with the flat base would silently re-base every account with no code
    // change anywhere near a pool. It is also the assertion that catches a
    // half-done base reduction — see "Lowering the base, later" in
    // freebuff-levels.ts, which lists the four edits that must land together.
    //
    // `freeSessionsPerDay` is the LIMITED-region pool, not the full-access
    // standard one — that pool is deliberately not on this ladder at all.
    expect(FREEBUFF_LEVEL_0.trustRequired).toBe(0)
    expect(FREEBUFF_LEVEL_0.freeSessionsPerDay).toBe(
      FREEBUFF_LIMITED_SESSION_LIMIT,
    )
    expect(FREEBUFF_LEVEL_0.premiumSessionsPerDay).toBe(
      FREEBUFF_PREMIUM_SESSION_LIMIT,
    )
  })

  it('does not reintroduce a full-access standard limit', () => {
    // The floor of the product is UNMETERED on every surface — the browser-only
    // pool was removed on 2026-08-18. A constant reappearing under this name
    // means somebody has started gating the thing Levels must never gate.
    expect(freebuffModels).not.toHaveProperty(
      'FREEBUFF_WEB_STANDARD_SESSION_LIMIT',
    )
    expect(freebuffModels).not.toHaveProperty('FREEBUFF_STANDARD_SESSION_LIMIT')
  })

  it('tops out at the ceiling the copy promises, on both pools', () => {
    expect(FREEBUFF_MAX_LEVEL.freeSessionsPerDay).toBe(
      FREEBUFF_LEVEL_SESSION_CEILING,
    )
    expect(FREEBUFF_MAX_LEVEL.premiumSessionsPerDay).toBe(
      FREEBUFF_LEVEL_SESSION_CEILING,
    )
    for (const tier of FREEBUFF_LEVELS) {
      expect(tier.freeSessionsPerDay).toBeLessThanOrEqual(
        FREEBUFF_LEVEL_SESSION_CEILING,
      )
      expect(tier.premiumSessionsPerDay).toBeLessThanOrEqual(
        FREEBUFF_LEVEL_SESSION_CEILING,
      )
    }
  })

  it('never takes a session away from where the base starts', () => {
    // The rule the first version of this file broke. Every rung must be at
    // least as good as level 0 on both pools, or "level up" is a downgrade for
    // somebody.
    for (const tier of FREEBUFF_LEVELS) {
      expect(tier.freeSessionsPerDay).toBeGreaterThanOrEqual(
        FREEBUFF_LEVEL_0.freeSessionsPerDay,
      )
      expect(tier.premiumSessionsPerDay).toBeGreaterThanOrEqual(
        FREEBUFF_LEVEL_0.premiumSessionsPerDay,
      )
    }
  })

  it('gets a limited-region account back above the old base within a few levels', () => {
    // The cut that actually stings is 6 → 3. This pins how much work undoing
    // it costs: if a re-tune pushes it past a handful of engagements, the
    // reduction has stopped being a nudge and become a wall.
    const recovered = FREEBUFF_LEVELS.find(
      (tier) =>
        tier.freeSessionsPerDay >= FREEBUFF_LIMITED_SESSION_LIMIT,
    )
    expect(recovered).toBeDefined()
    expect(recovered!.level).toBeLessThanOrEqual(5)
  })

  it('adds nothing at level 0 and only ever adds above it', () => {
    expect(levelSessionBonus(0)).toEqual({ free: 0, premium: 0 })
    for (const tier of FREEBUFF_LEVELS) {
      const bonus = levelSessionBonus(tier.level)
      expect(bonus.free).toBeGreaterThanOrEqual(0)
      expect(bonus.premium).toBeGreaterThanOrEqual(0)
    }
  })

  it('treats an unknown level as level 0 rather than throwing', () => {
    // A stored `level` column can outlive a curve edit. Reading it must land
    // on "no bonus", never on undefined arithmetic.
    expect(levelSessionBonus(999)).toEqual({ free: 0, premium: 0 })
    expect(levelSessionBonus(-3)).toEqual({ free: 0, premium: 0 })
  })
})

describe('levelForTrust', () => {
  it('holds a level from its threshold until the next one', () => {
    const first = FREEBUFF_LEVELS[1]!
    expect(levelForTrust(first.trustRequired - 1).level).toBe(0)
    expect(levelForTrust(first.trustRequired).level).toBe(1)
    expect(levelForTrust(first.trustRequired + 1).level).toBe(1)
  })

  it('clamps a negative balance to level 0', () => {
    // Spending below zero is allowed on purpose (FREEBUFF_TRUST_ALLOW_NEGATIVE)
    // and "you are level -1" is not a state any surface should have to render.
    expect(levelForTrust(-1).level).toBe(0)
    expect(levelForTrust(FREEBUFF_TRUST_MIN_BALANCE).level).toBe(0)
  })

  it('tops out rather than running off the end', () => {
    expect(levelForTrust(FREEBUFF_MAX_LEVEL.trustRequired * 10).level).toBe(
      FREEBUFF_MAX_LEVEL.level,
    )
    expect(nextLevelAfter(FREEBUFF_MAX_LEVEL.level)).toBeNull()
  })
})

describe('levelProgress', () => {
  it('measures from the CURRENT level floor, not from zero', () => {
    // The bug every progress bar of this shape ships with first: measuring
    // against the next threshold alone makes the bar jump BACKWARDS on
    // level-up. Just past a threshold must read as nearly empty.
    const second = FREEBUFF_LEVELS[2]!
    const justArrived = levelProgress(second.trustRequired)
    expect(justArrived.level).toBe(2)
    expect(justArrived.progress).toBeLessThan(0.05)

    const almostThere = levelProgress(FREEBUFF_LEVELS[3]!.trustRequired - 1)
    expect(almostThere.level).toBe(2)
    expect(almostThere.progress).toBeGreaterThan(0.95)
  })

  it('is full and terminal at the top rung', () => {
    const top = levelProgress(FREEBUFF_MAX_LEVEL.trustRequired)
    expect(top.progress).toBe(1)
    expect(top.nextLevelAt).toBeNull()
    expect(top.trustToNextLevel).toBeNull()
    expect(top.engagementsToNextLevel).toBeNull()
  })

  it('reports the remaining work in engagements, not just points', () => {
    // "600 points" is not a number anybody can act on; "four posts" is, and it
    // is the figure that decides whether someone starts.
    const zero = levelProgress(0)
    expect(zero.engagementsToNextLevel).toBe(
      Math.ceil(
        FREEBUFF_LEVELS[1]!.trustRequired / FREEBUFF_LEVEL_0.trustPerEngagement,
      ),
    )
    // Two engagements to the first rung is the opening offer; if a re-tune
    // makes it more than a handful, the ladder has stopped being startable.
    expect(zero.engagementsToNextLevel).toBeLessThanOrEqual(3)
  })

  it('never reports negative work remaining', () => {
    const below = levelProgress(FREEBUFF_TRUST_MIN_BALANCE)
    expect(below.progress).toBeGreaterThanOrEqual(0)
    expect(below.trustToNextLevel).toBeGreaterThan(0)
  })

  it('clamps a negative rendered Trust score', () => {
    expect(levelProgress(-404).trust).toBe(FREEBUFF_TRUST_MIN_BALANCE)
  })
})

describe('prompt costs', () => {
  it('decays slower than it is earned, at every level', () => {
    // The stated design goal, asserted rather than assumed: one engagement has
    // to buy a meaningful number of prompts, or the ladder is a meter and
    // people stop climbing it.
    for (const tier of FREEBUFF_LEVELS) {
      const premiumPrompts =
        tier.trustPerEngagement / FREEBUFF_TRUST_COST_PER_PROMPT.premium
      expect(premiumPrompts).toBeGreaterThanOrEqual(10)
    }
  })

  it('never prices a scarcer prompt below a cheaper one', () => {
    // Was a strict ordering. The rate is flat now, so the invariant worth
    // keeping is only that it never INVERTS — a frontier prompt must not cost
    // less than a standard one if the classes are ever split again.
    expect(FREEBUFF_TRUST_COST_PER_PROMPT.frontier).toBeGreaterThanOrEqual(
      FREEBUFF_TRUST_COST_PER_PROMPT.premium,
    )
    expect(FREEBUFF_TRUST_COST_PER_PROMPT.premium).toBeGreaterThanOrEqual(
      FREEBUFF_TRUST_COST_PER_PROMPT.standard,
    )
  })

  it('charges exactly 1 for a message, whatever it was sent to', () => {
    // The tiering (1/2/3/5, then 0/1/1/2) made the number unpredictable: the
    // same afternoon's work cost different amounts depending on which model
    // was selected, so nobody could form an expectation of how fast their
    // score moved. Flat 1 is a rate a person can reason about — an engagement
    // pays 50, so it covers 50 messages.
    for (const cost of Object.values(FREEBUFF_TRUST_COST_PER_PROMPT)) {
      expect(cost).toBe(1)
    }
  })

  it('never lets a balance go below zero', () => {
    // A negative score cannot be read as anything but a punishment, and this
    // one was being read as a fraud flag by the people it was meant to reward.
    expect(FREEBUFF_TRUST_MIN_BALANCE).toBe(0)
    expect(FREEBUFF_TRUST_ALLOW_NEGATIVE).toBe(false)
  })

  it('puts a spent-out user at level 0 rather than below it', () => {
    expect(levelForTrust(FREEBUFF_TRUST_MIN_BALANCE).level).toBe(0)
    expect(levelForTrust(0).level).toBe(0)
  })
})
