import { beforeAll, describe, expect, test } from 'bun:test'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import React from 'react'
import type { AdReport } from '@codebuff/common/ads/ad-report'
import { SPONSORED_ROW_FIXTURES } from '@codebuff/common/ads/__fixtures__/sponsored-proposal-rows'

import { AdCard, DockAdCard, DockDetailPanel } from '../ad-banner'
import { PartnerAdRow } from '../partner-ad-line'
import { SponsoredProposalBlock } from '../blocks/sponsored-proposal-block'
import { ProfileSurveyBoxView } from '../profile-survey-box'
import { AdReportButton, AdReportRegistryContext } from '../ad-report-button'
import { createAdReportRegistry } from '../../ads/ad-reports'
import { initializeThemeStore } from '../../hooks/use-theme'
import { sponsoredOfferToSurveyState } from '../../utils/sponsored-survey-api'

beforeAll(() => {
  initializeThemeStore()
})

const AD = {
  title: 'Original ad',
  url: 'https://example.com',
  adText: 'Original visible copy',
  cta: 'Try it',
  clickUrl: 'test-only:click',
  impUrl: 'original-impression',
  favicon: '',
}
const REASON = 'This ad makes a misleading claim.'

function locate(frame: string, label: string) {
  const lines = frame.split('\n')
  const y = lines.findIndex((line) => line.includes(label))
  expect(y).toBeGreaterThanOrEqual(0)
  return { x: lines[y]!.indexOf(label) + 2, y }
}

describe('ad report controls', () => {
  for (const kind of ['card', 'inline', 'dock', 'panel', 'partner'] as const) {
    test(`${kind}: reporting never activates the destination or expands the dock`, async () => {
      const sent: AdReport[] = []
      const registry = createAdReportRegistry(async (ad) => {
        sent.push(ad)
      })
      let actions = 0
      const activate = () => {
        actions++
      }
      const node =
        kind === 'card' || kind === 'inline' ? (
          <AdCard ad={AD} width={78} variant={kind} onClick={activate} />
        ) : kind === 'dock' ? (
          <DockAdCard
            ad={AD}
            width={78}
            onClick={activate}
            onToggle={activate}
          />
        ) : kind === 'panel' ? (
          <DockDetailPanel
            ad={AD}
            width={78}
            availableRows={20}
            onClick={activate}
            onClose={activate}
          />
        ) : (
          <PartnerAdRow
            ad={AD}
            width={78}
            reportClick={activate}
            open={activate}
          />
        )
      const setup = await createTestRenderer({ width: 78, height: 24 })
      const root = createRoot(setup.renderer)
      flushSync(() =>
        root.render(
          <AdReportRegistryContext.Provider value={registry}>
            {node}
          </AdReportRegistryContext.Provider>,
        ),
      )
      try {
        await setup.renderOnce()
        const { x, y } = locate(setup.captureCharFrame(), '[Report 1]')
        await setup.mockMouse.click(x, y)
        await setup.renderOnce()
        expect(sent).toEqual([])
        const prompt = registry.getPrompt()!
        expect(prompt.entry.snapshot.title).toBe(AD.title)
        await registry.submit(prompt.entry, REASON, prompt.send)
        await setup.renderOnce()
        expect(setup.captureCharFrame()).toContain('[Reported 1]')
        expect(sent).toHaveLength(1)
        expect(sent[0]).toMatchObject({
          title: AD.title,
          impUrl: AD.impUrl,
          surface: 'cli',
          reason: REASON,
        })
        expect(actions).toBe(0)
      } finally {
        flushSync(() => root.unmount())
        setup.renderer.destroy()
      }
    })
  }

  test('pending/error/retry and late completion stay with the original ad after rotation', async () => {
    let finish!: () => void
    const sent: AdReport[] = []
    let attempts = 0
    const registry = createAdReportRegistry(async (ad) => {
      attempts++
      if (attempts === 1) throw new Error('offline')
      sent.push(ad)
      await new Promise<void>((resolve) => {
        finish = resolve
      })
    })
    let rotate!: () => void
    const Host = () => {
      const [ad, setAd] = React.useState(AD)
      rotate = () => setAd({ ...AD, title: 'New ad', impUrl: 'new-impression' })
      return <AdReportButton ad={ad} registry={registry} />
    }
    const setup = await createTestRenderer({ width: 50, height: 3 })
    const root = createRoot(setup.renderer)
    flushSync(() => root.render(<Host />))
    try {
      await setup.renderOnce()
      await setup.mockMouse.click(4, 0)
      const prompt = registry.getPrompt()!
      expect(sent).toEqual([])
      await registry.submit(prompt.entry, REASON, prompt.send)
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain('[Retry 1]')
      await setup.mockMouse.click(4, 0)
      const sending = registry.submit(prompt.entry, REASON, prompt.send)
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain('[Sending… 1]')
      flushSync(() => rotate())
      finish()
      await sending
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain('[Report 2]')
      expect(setup.captureCharFrame()).not.toContain('Reported')
      expect(sent).toHaveLength(1)
      expect(sent[0]!.title).toBe('Original ad')
    } finally {
      flushSync(() => root.unmount())
      setup.renderer.destroy()
    }
  })

  test('agentic offers and sponsored survey questions are reportable without sharing answers', async () => {
    const sent: AdReport[] = []
    const registry = createAdReportRegistry(async (ad) => {
      sent.push(ad)
    })
    const state = sponsoredOfferToSurveyState(
      {
        campaignId: 'survey-campaign',
        sponsorName: 'Example',
        resumeAt: 0,
        rewardFreebucks: 0,
        questions: [
          {
            id: 'question-1',
            prompt: 'Which feature?',
            kind: 'single',
            position: 0,
            options: [{ id: 'one', label: 'Speed' }],
          },
        ],
      },
      0,
    )
    if (!state) throw new Error('Expected a valid sponsored survey fixture')
    state.textAnswer = 'Private response'
    state.answers = { 'question-1': ['one'] }
    const setup = await createTestRenderer({ width: 78, height: 30 })
    const root = createRoot(setup.renderer)
    flushSync(() =>
      root.render(
        <AdReportRegistryContext.Provider value={registry}>
          <box flexDirection="column">
            <SponsoredProposalBlock
              availableWidth={78}
              block={{
                type: 'sponsored-proposal',
                target: 'repo',
                proposal: {
                  ...SPONSORED_ROW_FIXTURES.committed,
                  _id: 'proposal-1',
                  advertiser_id: 'advertiser-1',
                },
              }}
            />
            <ProfileSurveyBoxView width={78} state={state} />
          </box>
        </AdReportRegistryContext.Provider>,
      ),
    )
    try {
      await setup.renderOnce()
      const frame = setup.captureCharFrame()
      expect(frame).toContain('[Report 1]')
      expect(frame).toContain('[Report 2]')
      for (const id of ['1', '2']) {
        expect(await registry.command(id)).toBeNull()
        const prompt = registry.getPrompt()!
        expect(sent).toHaveLength(Number(id) - 1)
        await registry.submit(prompt.entry, REASON, prompt.send)
      }
      expect(sent[0]!.proposalId).toBe('proposal-1')
      expect(sent[1]).toMatchObject({
        campaignId: 'survey-campaign',
        questionId: 'question-1',
        adText: 'Which feature?\nSpeed',
      })
      expect(JSON.stringify(sent)).not.toContain('Private response')
      expect(JSON.stringify(sent)).not.toContain('"answers"')
    } finally {
      flushSync(() => root.unmount())
      setup.renderer.destroy()
    }
  })
})
