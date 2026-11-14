import {
  TEMPLATE_CATEGORIES,
  templateCategoryOf,
  type TemplateCategory,
} from './categories'

/**
 * Category chips for a template gallery: optionally Featured, then All, then
 * one chip per template category tag (categories.ts) in that file's order.
 * Shared by the website builder landing and the TemplatePicker that Desktop
 * and the web workspace use.
 */
type CategoryTemplate = { id: string; kind: 'site' | 'app'; tags: string[] }

/** Picked for range (light and dark, sites and apps). Ids missing from the catalogue are skipped. */
export const FEATURED_TEMPLATE_IDS = [
  'estate-agent',
  'store',
  'moodboard',
  'tasks',
  'portfolio',
  'customer-health',
] as const

/**
 * The template picker's Featured chip (Sites page, new-project dialog, web
 * workspace): the eight showpieces, best first, in this order. Unlike the
 * landing's list it takes games. Ids missing from the catalogue are skipped.
 */
export const PICKER_FEATURED_TEMPLATE_IDS = [
  'crosscut',
  'retro-terminal',
  'creative-agency',
  'indie-game',
  'climate-story',
  'fusion-energy',
  'moodboard',
  'illustration-store',
] as const

const CHIP_LABEL: Record<TemplateCategory, string> = {
  'landing-page': 'Landing pages',
  store: 'Stores',
  portfolio: 'Portfolio',
  game: 'Games',
  saas: 'SaaS',
  starter: 'Starters',
}

const tagged = (template: CategoryTemplate, ...tags: string[]) =>
  template.tags.some((tag) => tags.includes(tag))

/**
 * Its category tag. An entry published before those tags existed keeps its
 * old tags in the live catalogue until the next full publish, so it gets a
 * guess from its kind and tags instead.
 */
export function templateCategory(template: CategoryTemplate): TemplateCategory {
  const category = templateCategoryOf(template.tags)
  if (category) return category
  if (template.kind === 'app') return tagged(template, 'game') ? 'game' : 'saas'
  if (tagged(template, 'ecommerce', 'store')) return 'store'
  if (tagged(template, 'portfolio', 'personal', 'blog')) return 'portfolio'
  return 'landing-page'
}

export type TemplateChip<T> = { id: string; label: string; templates: T[] }

export type TemplateChipOptions = {
  /**
   * Lead with a hand-picked Featured chip: `true` for the landing's
   * {@link FEATURED_TEMPLATE_IDS} in the order given, or a list of ids to show
   * in that list's order.
   */
  featured?: boolean | readonly string[]
  /**
   * Keep near-empty starter projects, in All and in their own Starters chip.
   * The landing leaves them out; a new-project picker keeps them.
   */
  starters?: boolean
}

/**
 * The chips, in order, each with its templates in the order given; empty ones
 * are left out. Defaults suit the landing: Featured on, starters out.
 */
export function templateCategories<T extends CategoryTemplate>(
  templates: T[],
  { featured = true, starters = false }: TemplateChipOptions = {},
): TemplateChip<T>[] {
  const kept = starters
    ? templates
    : templates.filter((template) => templateCategory(template) !== 'starter')
  const byId = new Map(kept.map((template) => [template.id, template]))
  const picked = new Set<string>(FEATURED_TEMPLATE_IDS)
  const featuredTemplates =
    featured === true
      ? kept.filter((template) => picked.has(template.id))
      : featured
        ? featured.flatMap((id) => {
            const template = byId.get(id)
            return template ? [template] : []
          })
        : []
  return [
    ...(featured
      ? [
          {
            id: 'featured',
            label: 'Featured',
            templates: featuredTemplates,
          },
        ]
      : []),
    { id: 'all', label: 'All', templates: kept },
    ...TEMPLATE_CATEGORIES.map((category) => ({
      id: category,
      label: CHIP_LABEL[category],
      templates: kept.filter(
        (template) => templateCategory(template) === category,
      ),
    })),
  ].filter((chip) => chip.templates.length > 0)
}
