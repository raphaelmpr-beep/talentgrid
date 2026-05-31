export {
  createTheirStackClient,
  mapJobToCompany,
  mapJobToRole,
  TheirStackNotConfiguredError,
  TheirStackRequestError,
} from "./theirstack";
export type {
  TheirStackClient,
  TheirStackJob,
  TheirStackSearchInput,
  TheirStackSearchResult,
  MappedCompany,
  MappedRole,
} from "./theirstack";

export {
  createEnrichmentClient,
  applyRevenueToMetadata,
  metadataHasRevenue,
  EnrichmentNotConfiguredError,
  EnrichmentRequestError,
  EnrichmentTargetUrlError,
} from "./enrichment";
export type {
  EnrichmentClient,
  CompanyEnrichmentInput,
  CompanyEnrichmentResult,
  PocCandidate,
  PocEnrichmentInput,
  PocEnrichmentResult,
  RevenueEstimate,
} from "./enrichment";

export {
  fetchCareersPortalJobs,
  extractJobsFromHtml,
  extractJobsWithTotal,
} from "./careers-portal";
export type {
  CareersPortalInput,
  CareersPortalJob,
  CareersPortalResult,
  CareersPortalOptions,
} from "./careers-portal";

export { fetchWikipediaRevenue, parseInfoboxRevenueValue } from "./wikipedia";
export type {
  WikipediaLookupInput,
  WikipediaLookupOptions,
  WikipediaLookupResult,
  WikipediaRevenueResult,
  WikipediaNoDataResult,
} from "./wikipedia";
