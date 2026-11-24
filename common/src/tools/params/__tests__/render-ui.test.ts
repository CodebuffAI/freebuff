import { describe, expect, it } from 'bun:test'

import { parseRenderUIButtonWidget, renderUIParams } from '../tool/render-ui'

describe('parseRenderUIButtonWidget', () => {
  it('preserves the resolved URL exactly', () => {
    const link =
      'https://index.trygravity.ai/go/resend?token=a%2Fb&opaque=(keep)'

    expect(
      parseRenderUIButtonWidget({
        type: 'button',
        text: ' Get Resend ',
        link,
        variant: 'secondary',
      }),
    ).toEqual({
      type: 'button',
      text: 'Get Resend',
      link,
      variant: 'secondary',
    })
  })

  it('defaults the visual variant and rejects unsafe or unresolved links', () => {
    expect(
      parseRenderUIButtonWidget({
        type: 'button',
        text: 'Open',
        link: 'https://example.com',
      }),
    ).toEqual({
      type: 'button',
      text: 'Open',
      link: 'https://example.com',
      variant: 'primary',
    })

    expect(
      parseRenderUIButtonWidget({
        type: 'button',
        text: 'Bad',
        link: 'javascript:alert(1)',
      }),
    ).toBeNull()
    expect(
      parseRenderUIButtonWidget({
        type: 'button',
        text: 'Padded',
        link: ' https://example.com ',
      }),
    ).toBeNull()
    expect(
      parseRenderUIButtonWidget({
        type: 'button',
        text: 'Unresolved',
        link: {
          source: 'gravity_index',
          search_id: 's1',
          service_slug: 'resend',
        },
      }),
    ).toBeNull()
  })
})

describe('render_ui input schema', () => {
  const parseWidget = (widget: unknown) => {
    const result = renderUIParams.inputSchema.safeParse({ widget })
    expect(result.success).toBe(true)
    return result.success ? (result.data.widget as Record<string, unknown>) : {}
  }

  it('strips runtime-only gravity fields a model tries to supply', () => {
    const spoofed = {
      gravity_search_id: 'search-1',
      gravity_service: { name: 'Fake', description: 'Spoofed card' },
    }

    const withUrl = parseWidget({
      type: 'button',
      text: 'Open',
      link: 'https://example.com',
      ...spoofed,
    })
    expect(withUrl).not.toHaveProperty('gravity_search_id')
    expect(withUrl).not.toHaveProperty('gravity_service')

    const withReference = parseWidget({
      type: 'button',
      text: 'Get Resend',
      link: {
        source: 'gravity_index',
        search_id: 'search-1',
        service_slug: 'resend',
      },
      ...spoofed,
    })
    expect(withReference).not.toHaveProperty('gravity_search_id')
    expect(withReference).not.toHaveProperty('gravity_service')

    // A widget sent as a JSON string goes through the same schema.
    const fromString = parseWidget(
      JSON.stringify({
        type: 'button',
        text: 'Open',
        link: 'https://example.com',
        ...spoofed,
      }),
    )
    expect(fromString).not.toHaveProperty('gravity_search_id')
    expect(fromString).not.toHaveProperty('gravity_service')
  })
})

describe('parseRenderUIButtonWidget gravity_service', () => {
  const base = {
    type: 'button',
    text: 'Get Resend',
    link: 'https://index.trygravity.ai/go/resend',
    gravity_search_id: 'search-1',
  }

  it('keeps a valid runtime-stamped service', () => {
    expect(
      parseRenderUIButtonWidget({
        ...base,
        gravity_service: { name: 'Resend', description: 'Email for devs' },
      }),
    ).toEqual({
      ...base,
      variant: 'primary',
      gravity_service: { name: 'Resend', description: 'Email for devs' },
    })
    expect(
      parseRenderUIButtonWidget({ ...base, gravity_service: { name: 'Resend' } }),
    ).toMatchObject({ gravity_service: { name: 'Resend' } })
  })

  it('rejects an invalid service', () => {
    expect(
      parseRenderUIButtonWidget({ ...base, gravity_service: { name: '' } }),
    ).toBeNull()
    expect(
      parseRenderUIButtonWidget({
        ...base,
        gravity_service: { name: 'x'.repeat(81) },
      }),
    ).toBeNull()
    expect(
      parseRenderUIButtonWidget({
        ...base,
        gravity_service: { name: 'Resend', description: '' },
      }),
    ).toBeNull()
  })
})
