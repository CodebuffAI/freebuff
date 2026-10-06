export type OrganizationRole = 'owner' | 'admin' | 'member'

export interface Organization {
  id: string
  name: string
  slug: string
  description?: string
  owner_id: string
  stripe_customer_id?: string
  created_at: Date
  updated_at: Date
}

export interface CreateOrganizationRequest {
  name: string
  slug?: string
  description?: string
}

export interface ListOrganizationsResponse {
  organizations: Array<{
    id: string
    name: string
    slug: string
    role: OrganizationRole
    memberCount: number
    repositoryCount: number
  }>
}

export interface OrganizationDetailsResponse {
  id: string
  name: string
  slug: string
  description?: string
  userRole: 'owner' | 'admin' | 'member'
  memberCount: number
  repositoryCount: number
  creditBalance: number
  hasStripeSubscription?: boolean
  stripeSubscriptionId?: string
}

export interface InviteMemberRequest {
  email: string
  role: 'admin' | 'member'
}

export interface UpdateMemberRoleRequest {
  role: 'admin' | 'member'
}

export interface AddRepositoryRequest {
  repository_url: string
  repository_name: string
}

export interface CreditDelegationResult {
  useOrganization: boolean
  organizationId?: string
  requiresOverride: boolean
  organizationBalance?: number
  userBalance?: number
}
