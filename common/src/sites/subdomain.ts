/** DNS labels only; the generated address namespace and DNS target are reserved. */
export function siteSubdomainError(input: string): string | null {
  const name = input.trim().toLowerCase()
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name))
    return 'Use 1–63 letters, numbers or hyphens. Start and end with a letter or number.'
  if (name === 'customers' || /^site-[a-f0-9]{32}$/.test(name))
    return 'This subdomain is reserved. Choose another name.'
  return null
}

export function siteHostname(env: {
  subdomain?: string | null
  worker_name: string
  domain: string
}) {
  return `${env.subdomain ?? env.worker_name}.${env.domain}`
}

export interface SiteSubdomainAvailability {
  subdomain: string
  available: boolean
}
