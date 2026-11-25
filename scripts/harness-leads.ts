import { createHarness } from '@strands-agents/harness'
import { tool } from '@strands-agents/sdk'
import z from 'zod'

if (!process.env.OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY')
  process.exit(1)
}

const crm = {
  lookup: (_company: string) => ({ industry: 'Technology', employees: 250 }),
  createLead: (email: string, company: string) => `lead_${email}:${company}`,
  getRepForRegion: (region: string) =>
    ({ 'US-West': 'Alice', 'US-East': 'Bob', EU: 'Carol' }[region] ?? 'Unassigned'),
  assign: (_leadId: string, _rep: string) => {},
}

const scoreLead = (data: { employees: number; industry: string }) =>
  Math.min(100, 50 + (data.employees >= 100 ? 20 : 0) + (data.industry === 'Technology' ? 15 : 0))

const classifyLead = tool({
  name: 'classify_lead',
  description: 'Score and classify a lead.',
  inputSchema: z.object({ email: z.string(), company: z.string() }),
  callback: ({ email, company }) => {
    const data = crm.lookup(company)
    return { leadId: crm.createLead(email, company), score: scoreLead(data), segment: data.industry }
  },
})

const routeToRep = tool({
  name: 'route_to_rep',
  description: 'Assign a lead to a rep.',
  inputSchema: z.object({ leadId: z.string(), region: z.string() }),
  callback: ({ leadId, region }) => {
    const rep = crm.getRepForRegion(region)
    crm.assign(leadId, rep)
    return `Assigned to ${rep}`
  },
})

const agent = await createHarness({ model: 'openai/gpt-4o-mini', tools: [classifyLead, routeToRep] })
await agent.invoke('New lead: jane@acme.com, Acme Corp, US-West')
