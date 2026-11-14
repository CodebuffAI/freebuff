import { describe, expect, test } from 'bun:test'

import { sitesGuidance } from '../guidance'
import { SITE_TOOL_SPECS } from '../tools'

/**
 * Reported 2026-10-15 as a GDPR complaint: "There is no documented pathway to
 * permanently delete data... no 'delete site' or 'wipe data' operation
 * available in the tooling", listing unpublish and "create a new site" as the
 * only dispositions.
 *
 * The complaint is right about the tools and wrong about the product. Erasure
 * has always existed — Delete site in the Sites panel calls
 * `DELETE /api/sites/:siteId`, which erases the Worker and its secrets, the D1
 * database, the R2 bucket and its objects, the custom domains and the site row
 * (`eraseSiteResources`) — but no `sites_*` description mentioned it, and
 * `sites_set_published` ended its retention sentence with no onward pointer. So
 * an agent asked how to remove a site's data had no true answer in its tools
 * and reported a gap that is not there.
 *
 * The fix is a description, not a tool: an agent must be able to name the
 * control, and must never be handed the control itself. Deleting someone's
 * database and bucket is a decision for the person, behind the panel's confirm.
 */
describe('the Sites tool surface', () => {
  const byName = new Map(SITE_TOOL_SPECS.map((spec) => [spec.name, spec]))

  test('hands the model no way to destroy a site, a database, a bucket or a secret value', () => {
    for (const spec of SITE_TOOL_SPECS) {
      expect(spec.name).not.toMatch(/delete|destroy|erase|wipe|purge|drop/i)
    }
    // `sites_set_secret` rotates a value; nothing removes storage or a project.
    expect([...byName.keys()].sort()).toEqual([
      'sites_add_storage',
      'sites_create',
      'sites_deploy',
      'sites_enable_auth',
      'sites_inspect',
      'sites_list',
      'sites_prepare_next',
      'sites_prepare_realtime',
      'sites_set_published',
      'sites_set_secret',
    ])
  })

  test('the tool that says data is retained also says where deletion lives, so the model never reports a gap that is not there', () => {
    const retaining = SITE_TOOL_SPECS.filter((spec) =>
      /retained/i.test(spec.description),
    )
    expect(retaining.map((spec) => spec.name)).toEqual(['sites_set_published'])
    const [{ description }] = retaining
    expect(description).toContain('Unpublishing is not deletion')
    expect(description).toContain('Delete site')
    // Name what goes, so the answer is specific rather than a shrug.
    for (const resource of ['D1 database', 'R2 bucket', 'secrets', 'domains']) {
      expect(description).toContain(resource)
    }
    expect(description).toContain('never tell the user there is no way to')
  })

  test('and says what to do when Delete site is the one thing that is refused', () => {
    // 106 sites cannot be deleted today: an operation of theirs never reported
    // its result, and `beginDeletion` refuses while one is outstanding. The
    // model must not answer that with "there is no way to remove it".
    const { description } = byName.get('sites_set_published')!
    expect(description).toContain('never reported its result')
    expect(description).toContain('support@freebuff.com')
  })

  // 2026-10-21: told only to save the site id "in the workspace", an agent
  // wrote it into .freebuff/project-id, the marker Desktop reads to find a
  // folder's chats, and the next launch opened the project with none of them.
  test('saving the site id never takes Freebuff’s own project marker', () => {
    expect(byName.get('sites_create')!.description).toContain(
      'never in .freebuff/project-id',
    )
    expect(sitesGuidance('build')).toContain('never in .freebuff/project-id')
  })
})
