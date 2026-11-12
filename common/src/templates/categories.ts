/**
 * Every starter template carries exactly one category tag, such as
 * `category:store`, in templates/templates.json. It rides in the free-form
 * `tags` list because the published catalogue's schema is strict
 * (catalog.ts): already-installed Desktop apps would refuse a whole catalogue
 * that gained a field.
 *
 * The Starter templates workflow (scripts/templates/check-categories.ts) and
 * the publish script refuse an entry without exactly one. The website builder
 * landing groups its gallery by it.
 *
 * Imports nothing, so the CI check runs without installing the repo.
 */
export const TEMPLATE_CATEGORIES = [
  'landing-page',
  'store',
  'portfolio',
  'game',
  'saas',
  'starter',
] as const
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number]

export const TEMPLATE_CATEGORY_TAG_PREFIX = 'category:'

/** What belongs in each, for whoever tags a new template. */
export const TEMPLATE_CATEGORY_GUIDE: Record<TemplateCategory, string> = {
  'landing-page': 'a marketing or business site (a product launch, a waitlist, an agency)',
  store: 'a shop that sells products',
  portfolio: 'a personal site (a portfolio, a blog)',
  game: 'a playable game',
  saas: 'a working app or tool people use (a CRM, a tracker, a dashboard)',
  starter: 'a near-empty project to build from; the website builder landing leaves these out',
}

export function templateCategoryTag(category: TemplateCategory): string {
  return `${TEMPLATE_CATEGORY_TAG_PREFIX}${category}`
}

function isTemplateCategory(value: string): value is TemplateCategory {
  return (TEMPLATE_CATEGORIES as readonly string[]).includes(value)
}

/** Why these tags don't name exactly one known category, or null when they do. */
export function templateCategoryProblem(entry: {
  id: string
  tags: readonly string[]
}): string | null {
  const named = entry.tags.filter((tag) =>
    tag.startsWith(TEMPLATE_CATEGORY_TAG_PREFIX),
  )
  const allowed = TEMPLATE_CATEGORIES.map(templateCategoryTag).join(', ')
  if (named.length === 0)
    return `${entry.id}: add exactly one category tag (${allowed})`
  if (named.length > 1)
    return `${entry.id}: has ${named.join(', ')}; keep exactly one category tag`
  if (!isTemplateCategory(named[0]!.slice(TEMPLATE_CATEGORY_TAG_PREFIX.length)))
    return `${entry.id}: ${named[0]} is not a category; use one of ${allowed}`
  return null
}

/** The template's category, or null when its tags name none, several, or an unknown one. */
export function templateCategoryOf(
  tags: readonly string[],
): TemplateCategory | null {
  const named = tags.filter((tag) => tag.startsWith(TEMPLATE_CATEGORY_TAG_PREFIX))
  if (named.length !== 1) return null
  const category = named[0]!.slice(TEMPLATE_CATEGORY_TAG_PREFIX.length)
  return isTemplateCategory(category) ? category : null
}
