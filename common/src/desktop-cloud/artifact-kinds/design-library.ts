import { HEX, emptyDesign, type Design, type DesignNode, type FrameNode, type IconName } from './design'
import { allIds, reidSubtree } from './design-tree'

/**
 * The built-in component library: ready-made sections (navigation, heroes, feature cards,
 * pricing, forms, footers, a mobile tab bar) the user inserts from the Assets panel and the agent
 * inserts with the `insertComponent` op ({"library": "<id>"}). Inserting copies plain nodes with
 * fresh ids into a frame; the copy is the user's to edit (or to mark as a main component).
 *
 * Templates colour everything with the standard token names. A design that lacks one of them
 * gets the default hex instead, so an insert always validates. `compact` builds the phone
 * variant (stacks instead of rows, one grid column, full-width buttons).
 */

export const LIBRARY_CATEGORIES = ['Navigation', 'Sections', 'Forms', 'App', 'Feedback'] as const
export type LibraryCategory = (typeof LIBRARY_CATEGORIES)[number]

export type LibraryEntry = {
  id: string
  label: string
  category: LibraryCategory
  description: string
  build: (compact: boolean) => FrameNode
}

type Rest<T> = Partial<Omit<T, 'type' | 'id' | 'children'>>
const frame = (id: string, layout: FrameNode['layout'], children: DesignNode[], rest: Rest<FrameNode> = {}): FrameNode => ({
  type: 'frame',
  id,
  layout,
  ...rest,
  children,
})
const text = (id: string, value: string, style: 'display' | 'h1' | 'h2' | 'h3' | 'body' | 'small' | 'caption', rest: { color?: string; w?: number | 'fill'; align?: 'start' | 'center' | 'end'; weight?: 400 | 500 | 600 | 700 } = {}): DesignNode => ({
  type: 'text',
  id,
  text: value,
  style,
  ...rest,
})
const icon = (id: string, name: IconName, size = 20, color = 'text'): DesignNode => ({ type: 'icon', id, icon: name, size, color })
const button = (id: string, label: string, variant: 'primary' | 'secondary' | 'ghost', rest: { w?: 'fill'; size?: 'sm' | 'md' | 'lg'; icon?: IconName } = {}): DesignNode => ({
  type: 'button',
  id,
  label,
  variant,
  ...rest,
})

const navbar: LibraryEntry = {
  id: 'navbar',
  label: 'Navigation bar',
  category: 'Navigation',
  description: 'Logo, links and a call to action',
  build: (compact) =>
    compact
      ? frame('navbar', 'stack-h', [text('navbar-logo', 'Acme', 'h3'), icon('navbar-menu', 'menu', 24)], {
          name: 'Navigation bar', w: 'fill', padding: [16, 24], justify: 'between', align: 'center', fill: 'background', stroke: 'border',
        })
      : frame(
          'navbar',
          'stack-h',
          [
            text('navbar-logo', 'Acme', 'h3'),
            frame('navbar-links', 'stack-h', [
              text('navbar-product', 'Product', 'small', { color: 'muted' }),
              text('navbar-pricing', 'Pricing', 'small', { color: 'muted' }),
              text('navbar-docs', 'Docs', 'small', { color: 'muted' }),
              button('navbar-signin', 'Sign in', 'secondary', { size: 'sm' }),
              button('navbar-cta', 'Get started', 'primary', { size: 'sm' }),
            ], { gap: 24, align: 'center' }),
          ],
          { name: 'Navigation bar', w: 'fill', padding: [20, 120], justify: 'between', align: 'center', fill: 'background', stroke: 'border' },
        ),
}

const tabBar: LibraryEntry = {
  id: 'tab-bar',
  label: 'Mobile tab bar',
  category: 'Navigation',
  description: 'Four tabs with icons, for phone screens',
  build: () => {
    const tab = (key: string, name: IconName, label: string, active = false): DesignNode =>
      frame(`tab-bar-${key}`, 'stack-v', [icon(`tab-bar-${key}-icon`, name, 22, active ? 'primary' : 'muted'), text(`tab-bar-${key}-label`, label, 'caption', { color: active ? 'primary' : 'muted' })], {
        gap: 4, align: 'center', grow: true,
      })
    return frame('tab-bar', 'stack-h', [tab('home', 'home', 'HOME', true), tab('search', 'search', 'SEARCH'), tab('inbox', 'bell', 'INBOX'), tab('profile', 'user', 'PROFILE')], {
      name: 'Tab bar', w: 'fill', padding: [12, 8], align: 'center', fill: 'background', stroke: 'border',
    })
  },
}

const footer: LibraryEntry = {
  id: 'footer',
  label: 'Footer',
  category: 'Navigation',
  description: 'Link columns and the small print',
  build: (compact) => {
    const column = (key: string, title: string, links: string[]): DesignNode =>
      frame(`footer-${key}`, 'stack-v', [text(`footer-${key}-title`, title, 'caption', { color: 'muted' }), ...links.map((link, i) => text(`footer-${key}-${i}`, link, 'small'))], { gap: 12 })
    return frame(
      'footer',
      'stack-v',
      [
        frame('footer-columns', compact ? 'grid' : 'stack-h', [
          column('product', 'PRODUCT', ['Features', 'Pricing', 'Changelog']),
          column('company', 'COMPANY', ['About', 'Careers', 'Contact']),
          column('legal', 'LEGAL', ['Privacy', 'Terms']),
        ], compact ? { columns: 2, gap: 24, w: 'fill' } : { gap: 96, w: 'fill' }),
        { type: 'divider', id: 'footer-rule' },
        text('footer-copyright', '© 2026 Acme, Inc. All rights reserved.', 'small', { color: 'muted' }),
      ],
      { name: 'Footer', w: 'fill', padding: compact ? [48, 24] : [64, 120], gap: 32, fill: 'surface' },
    )
  },
}

const heroCentered: LibraryEntry = {
  id: 'hero-centered',
  label: 'Hero, centred',
  category: 'Sections',
  description: 'Headline, a short lede and two buttons',
  build: (compact) =>
    frame(
      'hero',
      'stack-v',
      [
        text('hero-eyebrow', 'NEW: TEAM PLANS', 'caption', { color: 'primary', align: 'center' }),
        text('hero-headline', 'Plan the week in minutes, not meetings', compact ? 'h1' : 'display', { align: 'center', w: compact ? 'fill' : 880 }),
        text('hero-lede', 'Acme turns your team’s tasks and calendars into one shared plan everyone can see.', 'body', { color: 'muted', align: 'center', w: compact ? 'fill' : 560 }),
        frame('hero-ctas', compact ? 'stack-v' : 'stack-h', [
          button('hero-cta', 'Start free trial', 'primary', compact ? { size: 'lg', w: 'fill' } : { size: 'lg', icon: 'arrow-right' }),
          button('hero-secondary', 'Book a demo', 'ghost', compact ? { size: 'lg', w: 'fill' } : { size: 'lg' }),
        ], compact ? { gap: 12, w: 'fill', align: 'stretch' } : { gap: 12 }),
      ],
      { name: 'Hero', w: 'fill', padding: compact ? [48, 24] : [128, 120], gap: 24, align: 'center' },
    ),
}

const heroSplit: LibraryEntry = {
  id: 'hero-split',
  label: 'Hero with image',
  category: 'Sections',
  description: 'Copy on one side, a product shot on the other',
  build: (compact) =>
    frame(
      'hero-split',
      compact ? 'stack-v' : 'stack-h',
      [
        frame('hero-split-copy', 'stack-v', [
          text('hero-split-headline', 'Every invoice paid on time', compact ? 'h1' : 'display'),
          text('hero-split-lede', 'Automatic reminders, card payments and books that match, without the follow-up emails.', 'body', { color: 'muted' }),
          button('hero-split-cta', 'Start free trial', 'primary', compact ? { size: 'lg', w: 'fill' } : { size: 'lg', icon: 'arrow-right' }),
        ], compact ? { gap: 20, w: 'fill' } : { gap: 24, w: 520 }),
        { type: 'image', id: 'hero-split-shot', placeholder: 'chart', alt: 'Product screenshot', w: 'fill', h: compact ? 240 : 440, radius: 16 },
      ],
      { name: 'Hero', w: 'fill', padding: compact ? [48, 24] : [96, 120], gap: compact ? 32 : 64, align: compact ? 'stretch' : 'center' },
    ),
}

const featureCards: LibraryEntry = {
  id: 'feature-cards',
  label: 'Feature cards',
  category: 'Sections',
  description: 'A heading over a row of three cards',
  build: (compact) => {
    const card = (key: string, name: IconName, title: string, body: string): DesignNode =>
      frame(`features-${key}`, 'stack-v', [
        frame(`features-${key}-badge`, 'stack-v', [icon(`features-${key}-icon`, name, 20, 'primary')], { padding: 10, radius: 10, fill: 'surface' }),
        text(`features-${key}-title`, title, 'h3'),
        text(`features-${key}-body`, body, 'small', { color: 'muted' }),
      ], { gap: 12, padding: 24, radius: 12, stroke: 'border', fill: 'background' })
    return frame(
      'features',
      'stack-v',
      [
        text('features-heading', 'Everything your team needs', 'h2'),
        frame('features-grid', 'grid', [
          card('one', 'zap', 'Fast setup', 'Import your tasks and calendars in a couple of clicks.'),
          card('two', 'users', 'Shared plans', 'Everyone sees the same week, updated as work moves.'),
          card('three', 'shield', 'Private by default', 'Only the people you invite can see a plan.'),
        ], { columns: compact ? 1 : 3, gap: 24, w: 'fill' }),
      ],
      { name: 'Features', w: 'fill', padding: compact ? [48, 24] : [96, 120], gap: 40 },
    )
  },
}

const pricing: LibraryEntry = {
  id: 'pricing',
  label: 'Pricing table',
  category: 'Sections',
  description: 'Three plans with the middle one highlighted',
  build: (compact) => {
    const tier = (key: string, name: string, price: string, perks: string[], featured = false): DesignNode =>
      frame(`pricing-${key}`, 'stack-v', [
        text(`pricing-${key}-name`, name, 'h3', featured ? { color: 'primary' } : {}),
        frame(`pricing-${key}-price-row`, 'stack-h', [text(`pricing-${key}-price`, price, 'h1'), text(`pricing-${key}-per`, '/ month', 'small', { color: 'muted' })], { gap: 6, align: 'end' }),
        frame(`pricing-${key}-perks`, 'stack-v', perks.map((perk, i) =>
          frame(`pricing-${key}-perk-${i}`, 'stack-h', [icon(`pricing-${key}-perk-${i}-icon`, 'check', 16, 'primary'), text(`pricing-${key}-perk-${i}-text`, perk, 'small')], { gap: 8, align: 'center' }),
        ), { gap: 10 }),
        button(`pricing-${key}-cta`, featured ? 'Start free trial' : 'Choose plan', featured ? 'primary' : 'secondary', { w: 'fill' }),
      ], { gap: 20, padding: 28, radius: 16, stroke: featured ? 'primary' : 'border', strokeWidth: featured ? 2 : 1, fill: 'background', shadow: featured ? 'md' : undefined })
    return frame(
      'pricing',
      'stack-v',
      [
        text('pricing-heading', 'Simple, honest pricing', 'h2', { align: 'center' }),
        frame('pricing-tiers', 'grid', [
          tier('starter', 'Starter', '$0', ['Up to 3 people', '1 shared plan']),
          tier('team', 'Team', '$12', ['Unlimited people', 'Unlimited plans', 'Calendar sync'], true),
          tier('business', 'Business', '$29', ['Everything in Team', 'SSO and audit log', 'Priority support']),
        ], { columns: compact ? 1 : 3, gap: 24, w: 'fill' }),
      ],
      { name: 'Pricing', w: 'fill', padding: compact ? [48, 24] : [96, 120], gap: 40, align: 'center' },
    )
  },
}

const signupForm: LibraryEntry = {
  id: 'signup-form',
  label: 'Sign-up form',
  category: 'Forms',
  description: 'Name, email, password and terms',
  build: (compact) =>
    frame(
      'signup',
      'stack-v',
      [
        text('signup-title', 'Create your account', 'h2'),
        text('signup-lede', 'Free for 14 days. No card needed.', 'small', { color: 'muted' }),
        { type: 'input', id: 'signup-name', kind: 'text', label: 'Name', placeholder: 'Ada Lovelace', w: 'fill' },
        { type: 'input', id: 'signup-email', kind: 'text', label: 'Work email', placeholder: 'you@company.com', w: 'fill' },
        { type: 'input', id: 'signup-password', kind: 'text', label: 'Password', placeholder: 'At least 12 characters', w: 'fill' },
        { type: 'input', id: 'signup-terms', kind: 'checkbox', label: 'I agree to the terms and privacy policy' },
        button('signup-submit', 'Create account', 'primary', { w: 'fill', size: 'lg' }),
      ],
      { name: 'Sign-up form', w: compact ? 'fill' : 440, padding: compact ? 24 : 32, gap: 16, radius: 16, stroke: 'border', fill: 'background', shadow: compact ? undefined : 'sm' },
    ),
}

// ---- app screens and feedback (round 3)

const input = (id: string, kind: 'text' | 'search' | 'select' | 'checkbox' | 'toggle', rest: { label?: string; placeholder?: string; value?: string; checked?: boolean; w?: 'fill' | number } = {}): DesignNode => ({
  type: 'input',
  id,
  kind,
  ...rest,
})

const dashboardShell: LibraryEntry = {
  id: 'dashboard-shell',
  label: 'Dashboard shell',
  category: 'App',
  description: 'Sidebar, top bar and a row of stat cards',
  build: (compact) => {
    const stat = (key: string, label: string, value: string, delta: string): DesignNode =>
      frame(`dash-stat-${key}`, 'stack-v', [
        text(`dash-stat-${key}-label`, label, 'small', { color: 'muted' }),
        text(`dash-stat-${key}-value`, value, 'h2'),
        text(`dash-stat-${key}-delta`, delta, 'small', { color: 'primary' }),
      ], { gap: 6, padding: 20, radius: 12, stroke: 'border', fill: 'background' })
    const stats = frame('dash-stats', 'grid', [
      stat('revenue', 'Revenue', '$48,210', '+12% this month'),
      stat('orders', 'Orders', '1,284', '+4% this month'),
      stat('refunds', 'Refunds', '23', '−8% this month'),
    ], { columns: compact ? 1 : 3, gap: 16, w: 'fill' })
    const topBar = frame('dash-top', 'stack-h', [
      text('dash-title', 'Overview', compact ? 'h2' : 'h1'),
      compact ? icon('dash-menu', 'menu', 24) : input('dash-search', 'search', { placeholder: 'Search orders', w: 280 }),
    ], { name: 'Top bar', w: 'fill', justify: 'between', align: 'center' })
    const content = frame('dash-content', 'stack-v', [topBar, stats], { name: 'Content', grow: true, w: 'fill', padding: compact ? [24, 20] : 32, gap: 24 })
    if (compact) return frame('dash', 'stack-v', [content], { name: 'Dashboard', w: 'fill', fill: 'surface' })
    const navItem = (key: string, name: IconName, label: string, active = false): DesignNode =>
      frame(`dash-nav-${key}`, 'stack-h', [icon(`dash-nav-${key}-icon`, name, 18, active ? 'primary' : 'muted'), text(`dash-nav-${key}-label`, label, 'small', { color: active ? 'text' : 'muted', weight: active ? 600 : 400 })], {
        gap: 10, align: 'center', padding: [8, 12], radius: 8, w: 'fill', fill: active ? 'surface' : undefined,
      })
    const sidebar = frame('dash-sidebar', 'stack-v', [
      text('dash-brand', 'Acme', 'h3'),
      frame('dash-nav', 'stack-v', [
        navItem('home', 'home', 'Overview', true),
        navItem('orders', 'shopping-cart', 'Orders'),
        navItem('customers', 'users', 'Customers'),
        navItem('settings', 'settings', 'Settings'),
      ], { name: 'Navigation', gap: 4, w: 'fill' }),
    ], { name: 'Sidebar', w: 240, h: 'fill', padding: [24, 16], gap: 24, fill: 'background', stroke: 'border', strokeSides: ['right'] })
    return frame('dash', 'stack-h', [sidebar, content], { name: 'Dashboard', w: 'fill', h: 'fill', align: 'stretch', fill: 'surface' })
  },
}

const authSignin: LibraryEntry = {
  id: 'auth-signin',
  label: 'Sign-in screen',
  category: 'App',
  description: 'Email and password, a provider button and a sign-up link',
  build: (compact) =>
    frame('auth', 'stack-v', [
      frame('auth-card', 'stack-v', [
        { type: 'image', id: 'auth-logo', placeholder: 'logo', alt: 'Acme logo', w: 40, h: 40 },
        text('auth-title', 'Welcome back', 'h2'),
        text('auth-lede', 'Sign in to pick up where you left off.', 'small', { color: 'muted' }),
        button('auth-google', 'Continue with Google', 'secondary', { w: 'fill', size: 'lg' }),
        { type: 'divider', id: 'auth-rule' },
        input('auth-email', 'text', { label: 'Email', placeholder: 'you@company.com', w: 'fill' }),
        input('auth-password', 'text', { label: 'Password', placeholder: '••••••••••••', w: 'fill' }),
        button('auth-submit', 'Sign in', 'primary', { w: 'fill', size: 'lg' }),
        text('auth-switch', 'New to Acme? Create an account', 'small', { color: 'muted', align: 'center', w: 'fill' }),
      ], { name: 'Sign-in card', w: compact ? 'fill' : 400, padding: compact ? 24 : 32, gap: 16, radius: 16, fill: 'background', stroke: compact ? undefined : 'border', shadow: compact ? undefined : 'sm' }),
    ], { name: 'Sign in', w: 'fill', padding: compact ? [48, 0] : [96, 24], align: 'center', fill: compact ? 'background' : 'surface' }),
}

const settingsPage: LibraryEntry = {
  id: 'settings-page',
  label: 'Settings page',
  category: 'App',
  description: 'Profile fields and notification toggles in titled groups',
  build: (compact) => {
    const group = (key: string, title: string, lede: string, rows: DesignNode[]): DesignNode =>
      frame(`settings-${key}`, compact ? 'stack-v' : 'stack-h', [
        frame(`settings-${key}-head`, 'stack-v', [text(`settings-${key}-title`, title, 'h3'), text(`settings-${key}-lede`, lede, 'small', { color: 'muted' })], { gap: 4, w: compact ? 'fill' : 280 }),
        frame(`settings-${key}-rows`, 'stack-v', rows, { gap: 16, grow: true, w: 'fill', padding: 24, radius: 12, stroke: 'border', fill: 'background' }),
      ], { gap: compact ? 12 : 48, w: 'fill' })
    return frame('settings', 'stack-v', [
      text('settings-heading', 'Settings', 'h1'),
      group('profile', 'Profile', 'How you appear to your team.', [
        input('settings-name', 'text', { label: 'Full name', value: 'Ada Lovelace', w: 'fill' }),
        input('settings-email', 'text', { label: 'Email', value: 'ada@acme.com', w: 'fill' }),
        input('settings-tz', 'select', { label: 'Time zone', value: 'London (GMT+0)', w: 'fill' }),
      ]),
      { type: 'divider', id: 'settings-rule' },
      group('notify', 'Notifications', 'Choose what reaches your inbox.', [
        input('settings-weekly', 'toggle', { label: 'Weekly summary', checked: true, w: 'fill' }),
        input('settings-mentions', 'toggle', { label: 'Mentions and replies', checked: true, w: 'fill' }),
        input('settings-product', 'toggle', { label: 'Product news', w: 'fill' }),
      ]),
      frame('settings-actions', 'stack-h', [button('settings-cancel', 'Cancel', 'ghost'), button('settings-save', 'Save changes', 'primary')], { gap: 12, w: 'fill', justify: 'end' }),
    ], { name: 'Settings', w: 'fill', padding: compact ? [32, 20] : [64, 120], gap: 32 })
  },
}

const dataTable: LibraryEntry = {
  id: 'data-table',
  label: 'Data table',
  category: 'App',
  description: 'A header row and five rows with a status column',
  build: (compact) => {
    const columns = compact ? ['Customer', 'Status'] : ['Customer', 'Plan', 'Amount', 'Status']
    const rows = [
      ['Northwind Ltd', 'Team', '$1,240', 'Paid'],
      ['Blue Harbor', 'Business', '$3,900', 'Overdue'],
      ['Kestrel & Co', 'Starter', '$0', 'Paid'],
      ['Loft Studio', 'Team', '$860', 'Draft'],
      ['Pinecone Labs', 'Business', '$2,450', 'Paid'],
    ]
    const cells = (row: string[]) => (compact ? [row[0], row[3]] : row)
    const line = (key: string, values: string[], head = false): DesignNode =>
      frame(`table-${key}`, 'stack-h', values.map((value, i) =>
        text(`table-${key}-${i}`, head ? value.toUpperCase() : value, head ? 'caption' : 'small', {
          color: head ? 'muted' : value === 'Overdue' ? 'primary' : undefined,
          weight: !head && i === 0 ? 500 : undefined,
          w: 'fill',
        }),
      ), { w: 'fill', padding: [12, 16], gap: 16, align: 'center', stroke: 'border', strokeSides: ['bottom'], fill: head ? 'surface' : undefined })
    return frame('table', 'stack-v', [
      line('head', columns, true),
      ...rows.map((row, i) => line(`row-${i}`, cells(row))),
    ], { name: 'Table', w: 'fill', radius: 12, stroke: 'border', clip: true, fill: 'background' })
  },
}

const emptyState: LibraryEntry = {
  id: 'empty-state',
  label: 'Empty state',
  category: 'Feedback',
  description: 'An icon, a one-line reason and the next step',
  build: (compact) =>
    frame('empty', 'stack-v', [
      frame('empty-badge', 'stack-v', [icon('empty-icon', 'folder', 28, 'primary')], { padding: 16, radius: 999, fill: 'surface' }),
      text('empty-title', 'No projects yet', 'h3', { align: 'center' }),
      text('empty-body', 'Projects you create or are invited to show up here.', 'small', { color: 'muted', align: 'center', w: compact ? 'fill' : 360 }),
      button('empty-cta', 'Create a project', 'primary', { icon: 'plus', ...(compact ? { w: 'fill' as const } : {}) }),
    ], { name: 'Empty state', w: 'fill', padding: compact ? [48, 24] : [80, 24], gap: 12, align: 'center' }),
}

const modal: LibraryEntry = {
  id: 'modal',
  label: 'Dialog',
  category: 'Feedback',
  description: 'A titled dialog with a close button and two actions',
  build: (compact) =>
    frame('modal', 'stack-v', [
      { type: 'icon', id: 'modal-close', icon: 'x', size: 20, color: 'muted', absolute: true, anchor: 'top-right', x: 20, y: 20 },
      text('modal-title', 'Delete this project?', 'h3'),
      text('modal-body', 'Its boards, files and comments are removed for everyone. This cannot be undone.', 'small', { color: 'muted' }),
      frame('modal-actions', compact ? 'stack-v' : 'stack-h', [
        button('modal-cancel', 'Cancel', 'secondary', compact ? { w: 'fill' } : {}),
        button('modal-confirm', 'Delete project', 'primary', compact ? { w: 'fill' } : {}),
      ], { gap: 12, w: 'fill', justify: 'end', align: compact ? 'stretch' : 'center' }),
    ], { name: 'Dialog', w: compact ? 'fill' : 440, padding: 24, gap: 12, radius: 16, fill: 'background', stroke: 'border', shadow: 'lg' }),
}

const toast: LibraryEntry = {
  id: 'toast',
  label: 'Toast',
  category: 'Feedback',
  description: 'A short confirmation with an undo action',
  build: (compact) =>
    frame('toast', 'stack-h', [
      icon('toast-icon', 'check-circle', 18, 'primary'),
      text('toast-text', 'Invoice sent to Northwind Ltd', 'small', { weight: 500, ...(compact ? { w: 'fill' as const } : {}) }),
      button('toast-undo', 'Undo', 'ghost', { size: compact ? 'md' : 'sm' }),
    ], { name: 'Toast', w: compact ? 'fill' : 'hug', padding: [10, 12, 10, 16], gap: 12, align: 'center', radius: 12, fill: 'background', stroke: 'border', shadow: 'md' }),
}

export const DESIGN_LIBRARY: readonly LibraryEntry[] = [
  navbar, tabBar, footer, heroCentered, heroSplit, featureCards, pricing, signupForm,
  dashboardShell, authSignin, settingsPage, dataTable, emptyState, modal, toast,
]
export const LIBRARY_IDS = DESIGN_LIBRARY.map((entry) => entry.id)

export function libraryEntry(id: string): LibraryEntry | undefined {
  return DESIGN_LIBRARY.find((entry) => entry.id === id)
}

const DEFAULT_COLORS = emptyDesign().tokens!.colors
const COLOR_KEYS = ['fill', 'stroke', 'color'] as const

/** Colour names the design does not declare become the default hex (or are dropped). */
function fitColors(node: DesignNode, declared: Record<string, string>): DesignNode {
  const record: Record<string, unknown> = { ...node }
  for (const key of COLOR_KEYS) {
    const value = record[key]
    if (typeof value !== 'string' || HEX.test(value) || value === 'transparent' || Object.hasOwn(declared, value)) continue
    const fallback = DEFAULT_COLORS[value]
    if (fallback) record[key] = fallback
    else delete record[key]
  }
  if (node.type === 'frame') record.children = node.children.map((child) => fitColors(child, declared))
  for (const key of Object.keys(record)) if (record[key] === undefined) delete record[key]
  return record as DesignNode
}

/**
 * A library entry built for `design`: fresh ids (unique against the design), colours fitted to
 * its tokens. `compact` defaults to the target board being narrower than 600 px.
 */
export function libraryNode(design: Design, entryId: string, compact: boolean): FrameNode | null {
  const entry = libraryEntry(entryId)
  if (!entry) return null
  const built = fitColors(entry.build(compact), design.tokens?.colors ?? {})
  return reidSubtree(built, allIds(design)) as FrameNode
}
