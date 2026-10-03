'use strict';
const path = require('node:path');
const { createInsightStore, hash } = require('./insight_store.cjs');
const { createInsightHttp } = require('./insight_http.cjs');
const { createInsightPreparation } = require('./insight_preparation.cjs');
const { createCollectionResults } = require('./insight_collection_results.cjs');
const { createInsightAnalysis } = require('./insight_analysis.cjs');
const { POLICY_VERSION, insightPolicies } = require('./insight_policy.cjs');
const { createInsightAdminStore } = require('./insight_admin_store.cjs');
const { createInsightAdminProvisioning } = require('./insight_admin_provisioning.cjs');
function createInsightIntegration({ dataDir, readCatalog, readMembers, authenticateMember, registerMember, checkUsername, policyContext = {}, requireAdmin, collectorRequests, verifyStored, readEvidence, readCompanyDetail, readRegionContext, readRegionLocation, regionPreparation, env = process.env }) {
  if (env.INSIGHT_CONNECTION_ENABLED !== '1') return null;
  const serviceToken = env.INSIGHT_SERVICE_TOKEN;
  if (!serviceToken || serviceToken.length < 32) throw new Error('INSIGHT_SERVICE_TOKEN is required when Insight connection is enabled');
  const store = createInsightStore({ file: path.join(dataDir, 'customer_insight', 'insight.sqlite') });
  const adminStore = createInsightAdminStore({ file: path.join(dataDir, 'customer_insight', 'admins.sqlite') });
  async function catalog() {
    const data = await readCatalog();
    return { regions: data.regions, companies: data.companies.map(row => {
      const raw = data.rawCompanies.get(row.companyId);
      const reviewedProfile = raw.adminProfile?.active === true ? raw.adminProfile : {};
      const company = { companyId: row.companyId, name: reviewedProfile.primaryName || row.primaryName, address: reviewedProfile.address || String(typeof raw.addresses?.[0] === 'string' ? raw.addresses[0] : raw.addresses?.[0]?.address || row.regionLabel),
        placeIds: row.placeIds, regionKey: row.regionKey, regionLabel: row.regionLabel, rooms: row.capacity,
        roomCountSource: row.capacitySource, dayUse: 'unknown', facilities: (raw.manualCorrection?.facilityTags || []).join(', '),
        observedAt: raw.inventory?.latest?.collectedAt || null };
      return { ...company, version: hash(JSON.stringify({ company, correctionAt: raw.manualCorrection?.updatedAt || null })) };
    }) };
  }
  const collectionResults = readEvidence ? createCollectionResults({catalog,readEvidence,readCompanyDetail}) : null;
  const analysis=createInsightAnalysis({catalog,collectionResults,readRegionContext,readRegionLocation,regionPreparation});
  const preparationBridge = collectorRequests && verifyStored ? createInsightPreparation({store,catalog,collectorRequests,verifyStored,findReusable:collectionResults?.reusable}) : null;
  const signup = { enabled: env.INSIGHT_SIGNUP_ENABLED === '1', termsVersion: env.INSIGHT_TERMS_VERSION || POLICY_VERSION, privacyVersion: env.INSIGHT_PRIVACY_VERSION || POLICY_VERSION, termsUrl: env.INSIGHT_TERMS_URL || '/terms', privacyUrl: env.INSIGHT_PRIVACY_URL || '/privacy' };
  const handlers = createInsightHttp({ store, serviceToken, catalog, authenticateMember, registerMember, checkUsername, requireAdmin, preparationBridge, collectionResults, analysis,
    memberActive: async memberId => (await readMembers()).members.some(row => row.memberId === memberId && row.status !== 'disabled' && row.role === 'b2b'),
    signup, policies: insightPolicies(policyContext), supportEmail: policyContext.contactEmail || '', adminStore });
  return { ...handlers, store, adminStore, provision: createInsightAdminProvisioning({ adminStore, requireAdmin }) };
}
module.exports = { createInsightIntegration };
