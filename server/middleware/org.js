'use strict';

/**
 * Org-tenancy middleware (Phase E8).
 *
 *   requireOrg(req, res, next)
 *
 * Loads the authenticated user's currentOrgId, verifies that the user is
 * still a member of that org (defending against revoked memberships
 * whose currentOrgId pointer hasn't been cleared), and attaches:
 *
 *   req.org = { id, name, slug, role }
 *
 * where `role` is the user's role WITHIN this org (`owner` | `admin` |
 * `member`). Routes can also use `requireOrgRole('owner', 'admin')` to
 * gate destructive actions to non-members.
 *
 * Failure modes:
 *   - 401 / no session  → middleware does NOT handle this; requireAuth
 *                          must run first.
 *   - 412 NO_ORG        → user has no currentOrgId set. Happens to legacy
 *                          rows whose backfill didn't run (shouldn't be
 *                          possible post-E8 migration), or to users mid-
 *                          signup before the Solo org was created.
 *   - 403 FORBIDDEN_ORG → user has currentOrgId but no OrgMembership.
 *                          Owner may have revoked their access mid-session.
 *
 * Why not embed orgId in the JWT? Stale-org-after-switch is the killer:
 * if a user switches their active org and an old JWT is still valid (it
 * has a 15-min TTL), the old request would still see the stale org.
 * One DB lookup per request is cheap; QAAI's scale doesn't justify the
 * complexity of revalidating JWTs on org change.
 */

const prisma = require('../prisma');
const userContext = require('../lib/userContext');

async function requireOrg(req, res, next) {
  if (!req.user || !req.user.id) {
    // Defence in depth — requireAuth should have set this.
    return res.status(401).json({ success: false, code: 'NO_SESSION' });
  }
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, currentOrgId: true },
    });
    if (!user || !user.currentOrgId) {
      return res.status(412).json({
        success: false,
        code: 'NO_ORG',
        message: 'No active organization. Accept an invite or contact your admin.',
      });
    }
    const membership = await prisma.orgMembership.findUnique({
      where: { orgId_userId: { orgId: user.currentOrgId, userId: user.id } },
      select: {
        role: true,
        organization: { select: { id: true, name: true, slug: true } },
      },
    });
    if (!membership || !membership.organization) {
      // currentOrgId points to an org the user is no longer a member of.
      return res.status(403).json({
        success: false,
        code: 'FORBIDDEN_ORG',
        message: 'You are no longer a member of this organization. Switch orgs to continue.',
      });
    }
    req.org = {
      id: membership.organization.id,
      name: membership.organization.name,
      slug: membership.organization.slug,
      role: membership.role,
    };
    // Mirror onto req.user.orgId for routes that read from req.user.
    req.user.orgId = membership.organization.id;
    req.user.orgRole = membership.role;
    // E10.3 — propagate orgId into the AsyncLocalStorage scope opened
    // by requireAuth so any downstream agent / provider call can read
    // it for budgeting / org-scoped accounting without threading it.
    userContext.setOrgId(membership.organization.id);
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Gate a route to specific org roles. Use after requireOrg.
 *
 *   router.delete('/projects/:id', requireAuth, requireOrg, requireOrgRole('owner', 'admin'), handler)
 */
function requireOrgRole(...roles) {
  return (req, res, next) => {
    if (!req.org) {
      return res.status(412).json({ success: false, code: 'NO_ORG' });
    }
    if (!roles.includes(req.org.role)) {
      return res.status(403).json({
        success: false,
        code: 'FORBIDDEN_ORG_ROLE',
        message: `Action restricted to ${roles.join(' / ')} in this org.`,
        yourRole: req.org.role,
      });
    }
    next();
  };
}

module.exports = { requireOrg, requireOrgRole };
