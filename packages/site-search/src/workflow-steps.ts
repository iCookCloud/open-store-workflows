import { ConditionKey, type ParamDecl, type StepDef, z } from '@osw/core';
import { SiteDecision } from './contracts.js';
import {
  CounselInput,
  CounselShortlist,
  DocDraft,
  LeaseReview,
  LeaseReviewInput,
  LoiInput,
  draftLoi,
  matchCounsel,
  reviewLease,
} from './steps/legal.js';
import { ScanInput, Surroundings, scanSurroundings } from './steps/scan.js';
import { Screening, ScreeningInput, screenListings } from './steps/screen.js';
import {
  Assessment,
  AssessmentInput,
  ChooseInput,
  Shortlist,
  ShortlistInput,
  assessSite,
  chooseSite,
  shortlist,
} from './steps/selection.js';
import { SignInput, signLease } from './steps/sign.js';
import { Survey, SurveyInput, surveySite } from './steps/survey.js';
function define<I extends z.ZodType, O extends z.ZodType>(
  name: string,
  input: I,
  output: O,
  reads: string[],
  params: string[],
  run: StepDef<I, O>['run'],
  decisions?: string[],
): StepDef<I, O> {
  return {
    id: `site-search/${name}`,
    input,
    output,
    reads,
    params: params.map((key) => ({ key, required: true, description: key })),
    run,
    ...(decisions
      ? { approval: { question: name, decision: z.enum(decisions as [string, ...string[]]) } }
      : {}),
  };
}
const evidence = [
  'site.evidenceMaxAgeDays',
  ...['observed', 'claimed', 'quote', 'estimate'].map((b) => `site.evidenceMaxAgeDays.${b}`),
];
const economics = ['site.maxOccupancyRatio', 'site.minResidents'];
export const workflowSteps: readonly StepDef[] = [
  define(
    'screenListings',
    ScreeningInput,
    Screening,
    ['listing', 'trade-area', 'params'],
    ['site.searchRadiusKm', 'site.screenLimit', ...evidence, ...economics],
    screenListings,
  ),
  define(
    'scanSurroundings',
    ScanInput,
    Surroundings,
    ['listing', 'competitor-query', 'place-observation'],
    [
      'site.competitorRadiusKm',
      'site.maxScansPerDecision',
      'places.dailyCap',
      'places.reuseDays',
      'listingFeed.reuseHours',
      'listingFeed.maxItemsPerRun',
      'listingFeed.maxChargePerRun',
    ],
    scanSurroundings,
  ),
  define('shortlist', ShortlistInput, Shortlist, ['listing'], ['site.shortlistMax'], shortlist, [
    'accept',
    'revise',
  ]),
  define(
    'assessSite',
    AssessmentInput,
    Assessment,
    ['listing', 'trade-area', 'template'],
    [...evidence, ...economics],
    assessSite,
  ),
  define(
    'surveySite',
    SurveyInput,
    Survey,
    ['listing', 'place-observation'],
    [
      'site.claimTolerance',
      ...ConditionKey.options.map((k) => `site.claimTolerance.${k}`),
      ...evidence,
    ],
    surveySite,
  ),
  define('chooseSite', ChooseInput, SiteDecision, [], [], chooseSite, ['choose', 'waive']),
  define('matchCounsel', CounselInput, CounselShortlist, ['party'], [], matchCounsel, ['engage']),
  define('draftLoi', LoiInput, DocDraft, ['template'], [], draftLoi, ['send']),
  define('reviewLease', LeaseReviewInput, LeaseReview, ['template', 'party'], [], reviewLease, [
    'approve',
    'reject',
  ]),
  define('signLease', SignInput, SiteDecision, ['party', 'listing'], [], signLease, ['sign']),
];
