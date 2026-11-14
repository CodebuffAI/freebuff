import { describe, expect, test } from 'bun:test'

import {
  AD_REPORT_REASON_MAX_LENGTH,
  AD_REPORT_REASON_MIN_LENGTH,
  AdReportReasonSchema,
  AdReportSchema,
  toAdReport,
  toSponsoredProposalAdReport,
  toSponsoredSurveyAdReport,
} from './ad-report'

const ad = { title: 'Example ad', url: 'https://example.com/product' }

describe('ad report payload', () => {
  test('preserves a written reason through selection and normalizes it on parsing', () => {
    const reason =
      '  This ad falsely promises a guaranteed refund.\nPlease review it.  '
    const selected = toAdReport({ ...ad, reason })
    expect(selected.reason).toBe(reason)
    expect(
      AdReportSchema.parse(JSON.parse(JSON.stringify(selected))).reason,
    ).toBe(reason.trim())
    expect(AdReportSchema.safeParse(toAdReport(ad)).success).toBe(true)
  })

  test('bounds supplied reasons after trimming without truncating them', () => {
    for (const size of [
      AD_REPORT_REASON_MIN_LENGTH,
      AD_REPORT_REASON_MAX_LENGTH,
    ]) {
      const reason = 'x'.repeat(size)
      expect(AdReportReasonSchema.parse(` \n${reason}\t `)).toBe(reason)
      expect(AdReportSchema.safeParse({ ...ad, reason }).success).toBe(true)
    }
    for (const reason of [
      '',
      ' \n\t ',
      `  ${'x'.repeat(AD_REPORT_REASON_MIN_LENGTH - 1)}  `,
      'x'.repeat(AD_REPORT_REASON_MAX_LENGTH + 1),
      null,
      42,
    ]) {
      expect(AdReportReasonSchema.safeParse(reason).success).toBe(false)
      expect(AdReportSchema.safeParse({ ...ad, reason }).success).toBe(false)
    }
    const reason = 'x'.repeat(AD_REPORT_REASON_MAX_LENGTH + 1)
    expect(toAdReport({ ...ad, reason }).reason).toBe(reason)
  })

  test('reports offers and sponsored questions without inventing a destination or including answers', () => {
    const proposal = toSponsoredProposalAdReport(
      {
        _id: 'p1',
        headline: 'Try a tool',
        body: 'Sponsor copy',
        advertiser_name: 'Example',
      },
      'cli',
    )
    expect(AdReportSchema.safeParse(proposal).success).toBe(true)
    expect(proposal.url).toBeUndefined()
    expect(proposal.proposalId).toBe('p1')
    const survey = toSponsoredSurveyAdReport(
      { campaignId: 's1', sponsorName: 'Example' },
      'web',
      {
        id: 'q1',
        prompt: 'Which editor?',
        options: [{ label: 'Vim' }],
        ...{ textAnswer: 'Private answer' },
      },
    )
    expect(AdReportSchema.safeParse(survey).success).toBe(true)
    expect(survey.adText).toBe('Which editor?\nVim')
    expect(survey.questionId).toBe('q1')
    expect(JSON.stringify(survey)).not.toContain('Private answer')
    expect(
      AdReportSchema.safeParse({ title: 'No identifiable ad' }).success,
    ).toBe(false)
  })
  test('still reports a visible ad with a blank title', () => {
    const report = toAdReport({ ...ad, title: ' \n ' })
    expect(report.title).toBe('Untitled ad')
    expect(AdReportSchema.safeParse(report).success).toBe(true)
  })

  test('a creative with only a tracked destination remains reportable', () => {
    for (const url of [undefined, '', ' ']) {
      const report = toAdReport({
        title: ad.title,
        url,
        clickUrl: 'https://example.com/click/token',
      })
      expect(AdReportSchema.safeParse(report).success).toBe(true)
      expect(report.url).toBe('https://example.com/click/token')
      expect(report).not.toHaveProperty('clickUrl')
    }
    expect(
      toAdReport({ ...ad, clickUrl: 'https://example.com/click/token' }).url,
    ).toBe(ad.url)
  })

  test('selects ad content without carrying targeting or conversation data', () => {
    const selected = toAdReport({
      ...ad,
      adText: 'Try this product',
      surface: 'freebuff_web_chat',
      ...{ messages: ['private prompt'], targeting: { userTags: ['private'] } },
    })
    expect(selected.adText).toBe('Try this product')
    expect(selected).not.toHaveProperty('messages')
    expect(selected).not.toHaveProperty('targeting')
    expect(AdReportSchema.parse({ ...ad, messages: ['private'] })).toEqual(ad)
  })

  test('bounds every field and rejects unsafe destination schemes and credentials', () => {
    for (const url of [
      'javascript:alert(1)',
      'file:///tmp/test',
      'https://user:password@example.com',
    ]) {
      expect(AdReportSchema.safeParse({ ...ad, url }).success).toBe(false)
    }
    for (const [field, size] of Object.entries({
      title: 301,
      url: 4097,
      adText: 6001,
      provider: 65,
      surface: 81,
      placementId: 161,
      impUrl: 4097,
    })) {
      expect(
        AdReportSchema.safeParse({ ...ad, [field]: 'x'.repeat(size) }).success,
      ).toBe(false)
    }
    expect(AdReportSchema.safeParse({ ...ad, title: ' ' }).success).toBe(false)
  })
})
