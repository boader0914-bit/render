'use strict';
const path = require('node:path');
const { createInsightStore, hash } = require('./insight_store.cjs');
const { createInsightHttp } = require('./insight_http.cjs');
const { createInsightPreparation, insightCollectionWorkerKey } = require('./insight_preparation.cjs');
const { createCollectionResults } = require('./insight_collection_results.cjs');
const { createInsightAnalysis } = require('./insight_analysis.cjs');
const { createInsightSavedReportSources } = require('./insight_saved_report_sources.cjs');
const { POLICY_VERSION, insightPolicies } = require('./insight_policy.cjs');
const { createInsightAdminStore } = require('./insight_admin_store.cjs');
const { createInsightAdminProvisioning } = require('./insight_admin_provisioning.cjs');
const { createInsightCatalog } = require('./insight_catalog.cjs');
// Match the existing reviewed-room convention without invoking capacity/history
// preparation merely to authenticate or display a company's identity.
function reviewedRooms(company) {
  const correction=company?.manualCorrection;
  if(!correction||correction.active===false)return null;
  const explicit=Number(correction.lodgingBasisTotal);
  if(Number.isFinite(explicit)&&explicit>0)return Math.round(explicit);
  const count=(Array.isArray(correction.roomSegments)?correction.roomSegments:[]).reduce((sum,row)=>{
    const value=Number(String(row?.count??row?.roomCount??'').replace(/,/g,'').replace(/[^\d.]/g,''));
    return sum+(Number.isFinite(value)&&value>0?Math.round(value):0);
  },0);
  return count>0?count:null;
}
function createInsightIntegration({ dataDir, readCatalog, readMembers, authenticateMember, registerMember, checkUsername, policyContext = {}, requireAdmin, collectorRequests, verifyStored, readPostprocess, readEvidence, readCompanyDetail, readIntegrated, readRegionContext, readRegionLocation, regionPreparation, env = process.env }) {
  if (env.INSIGHT_CONNECTION_ENABLED !== '1') return null;
  const serviceToken = env.INSIGHT_SERVICE_TOKEN;
  if (!serviceToken || serviceToken.length < 32) throw new Error('INSIGHT_SERVICE_TOKEN is required when Insight connection is enabled');
  const workerKey = insightCollectionWorkerKey(env.INSIGHT_COLLECTION_WORKER_KEY);
  const store = createInsightStore({ file: path.join(dataDir, 'customer_insight', 'insight.sqlite') });
  const adminStore = createInsightAdminStore({ file: path.join(dataDir, 'customer_insight', 'admins.sqlite') });
  // Deployed services use a separate, source-verified identity projection. It
  // never joins the monthly analytical lease; injected development adapters
  // retain their contract unless the fast reader is explicitly selected.
  const metadataEnabled=env.INSIGHT_METADATA_READ_ENABLED!=='0'&&(env.INSIGHT_METADATA_READ_ENABLED==='1'||env.NODE_ENV==='production'||Boolean(env.RENDER||env.RENDER_SERVICE_ID||env.RENDER_GIT_COMMIT));
  const metadataCatalog=metadataEnabled?createInsightCatalog({dataDir,
    regionMasterFile:path.join(__dirname,'..','..','web','data','region_master.json'),reviewedCapacity:reviewedRooms}):null;
  if(metadataCatalog)void metadataCatalog.prepare().catch(()=>{});
  async function catalog() {
    const data = await (metadataCatalog?metadataCatalog.catalog():readCatalog());
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
  const collectionResults = readEvidence ? createCollectionResults({catalog,readEvidence,readCompanyDetail,readIntegrated}) : null;
  const savedCollectionResults=createInsightSavedReportSources({dataDir});
  const analysis=createInsightAnalysis({catalog,collectionResults,savedCollectionResults,readRegionContext,readRegionLocation,regionPreparation});
  const preparationBridge = collectorRequests && verifyStored ? createInsightPreparation({store,catalog,collectorRequests,verifyStored,readPostprocess,findReusable:collectionResults?.reusable,workerKey}) : null;
  const signup = { enabled: env.INSIGHT_SIGNUP_ENABLED === '1', termsVersion: env.INSIGHT_TERMS_VERSION || POLICY_VERSION, privacyVersion: env.INSIGHT_PRIVACY_VERSION || POLICY_VERSION, termsUrl: env.INSIGHT_TERMS_URL || '/terms', privacyUrl: env.INSIGHT_PRIVACY_URL || '/privacy' };
  const handlers = createInsightHttp({ store, serviceToken, catalog, authenticateMember, registerMember, checkUsername, requireAdmin, preparationBridge, collectionResults, savedCollectionResults, analysis,
    memberActive: async memberId => (await readMembers()).members.some(row => row.memberId === memberId && row.status !== 'disabled' && row.role === 'b2b'),
    signup, policies: insightPolicies(policyContext), supportEmail: policyContext.contactEmail || '', adminStore });
  return { ...handlers, store, adminStore, metadataCatalog, provision: createInsightAdminProvisioning({ adminStore, requireAdmin }) };
}
module.exports = { createInsightIntegration, reviewedRooms };
