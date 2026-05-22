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
