import { describe, expect, it } from 'vitest';
import {
  SAAS_TERMS_GATE_FLAGS,
  serviceClientSignals,
  serviceTermsGaps,
  serviceUsageGaps,
  serviceWarnings,
  upstreamProviderSignals,
} from '../../../src/core/service-terms.js';
import type { Decision, Evaluation, LedgerState } from '../../../src/types.js';

describe('serviceClientSignals', () => {
  it.each([
    ['openai', 'Official Python library for the OpenAI API'],
    ['firebase', 'Firebase JavaScript API'],
    ['RevenueCat/purchases-android', 'In-app purchases and subscriptions on Android'],
    ['livekit-plugins-elevenlabs', 'Agent Framework plugin for voice synthesis with ElevenLabs'],
    ['some-lib', 'Official Node.js SDK for the Acme platform'],
    ['some-lib', 'An API client for Acme'],
    ['some-lib', 'A client library for the Acme cloud API'],
    ['some-lib', 'Thin wrapper around the Acme REST API'],
    ['google-cloud-storage', ''],
  ])('flags %s', (id, descriptor) => {
    expect(serviceClientSignals(id, descriptor).length).toBeGreaterThan(0);
  });

  it.each([
    ['livekit/livekit', 'End-to-end stack for building real-time audio/video applications'],
    ['silero-vad', 'Pre-trained enterprise-grade Voice Activity Detector'],
    ['SYSTRAN/faster-whisper', 'Faster Whisper transcription with CTranslate2'],
    ['markdown-it', 'Markdown parser, done right. Mentions OpenAI and Stripe in its docs.'],
    ['left-pad', ''],
  ])('does not flag %s', (id, descriptor) => {
    expect(serviceClientSignals(id, descriptor)).toEqual([]);
  });

  it('matches vendor tokens on whole name parts only', () => {
    expect(serviceClientSignals('openaiish', '')).toEqual([]);
    expect(serviceClientSignals('googlecloud', '')).toEqual([]);
    expect(serviceClientSignals('google-cloud-tasks', '')).toEqual(['name mentions google-cloud']);
  });

  it('stays fast and bounded on hostile descriptions', () => {
    const hostile = `official ${'a '.repeat(50000)}`;
    const started = Date.now();
    serviceClientSignals('x', hostile);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('serviceTermsGaps', () => {
  it('reports a missing evaluation, the gate flags, or nothing', () => {
    expect(serviceTermsGaps(undefined)).toEqual(['not evaluated']);
    expect(serviceTermsGaps({ flags: ['saas_terms_unverified', 'other'] })).toEqual(['saas_terms_unverified']);
    expect(serviceTermsGaps({ flags: ['saas_evidence_missing', 'saas_terms_secondhand'] })).toEqual(['saas_evidence_missing', 'saas_terms_secondhand']);
    expect(serviceTermsGaps({ flags: ['vendor_lock_in'] })).toEqual([]);
    expect(SAAS_TERMS_GATE_FLAGS).toHaveLength(3);
  });
});

function evaluation(over: Partial<Evaluation>): Evaluation {
  return { component_id: 'speech', ref: 'pypi:client', flags: [], hint: 'adopt', ...over } as Evaluation;
}

function decision(over: Partial<Decision> = {}): Decision {
  return { component_id: 'speech', decision: 'adopt', ref: 'pypi:client', ...over } as Decision;
}

const state = (evaluations: Evaluation[], decisions: Decision[]) => ({ evaluations, decisions }) as Pick<LedgerState, 'evaluations' | 'decisions'>;

describe('serviceUsageGaps / serviceWarnings', () => {
  const linked = evaluation({ service_ref: 'saas:acme/api' });

  it('reports a decided client whose service is missing or unconfirmed', () => {
    expect(serviceUsageGaps(state([linked], [decision()]))).toEqual([
      expect.objectContaining({ ref: 'pypi:client', service_ref: 'saas:acme/api', reason: 'the terms of saas:acme/api are not confirmed (not evaluated)' }),
    ]);
    const unverified = evaluation({ ref: 'saas:acme/api', flags: ['saas_terms_secondhand'] });
    expect(serviceUsageGaps(state([linked, unverified], [decision({ decision: 'extend' })]))[0]?.reason).toContain('saas_terms_secondhand');
  });

  it('clears once the service is confirmed, and ignores other components and other decisions', () => {
    const confirmed = evaluation({ ref: 'saas:acme/api' });
    expect(serviceUsageGaps(state([linked, confirmed], [decision()]))).toEqual([]);
    expect(serviceUsageGaps(state([linked], [decision({ decision: 'reference' })]))).toEqual([]);
    expect(serviceUsageGaps(state([linked], [decision({ decision: 'build', ref: undefined })]))).toEqual([]);
    const otherComponent = evaluation({ component_id: 'other', ref: 'saas:acme/api' });
    expect(serviceUsageGaps(state([linked, otherComponent], [decision()]))).toHaveLength(1);
  });

  it('reports a suspected client without link or exemption', () => {
    const suspected = evaluation({ flags: ['service_client_suspected'] });
    expect(serviceUsageGaps(state([suspected], [decision()]))[0]?.reason).toContain('neither service_ref nor no_service_reason');
    expect(serviceUsageGaps(state([evaluation({ flags: [] })], [decision()]))).toEqual([]);
  });

  it('words one warning per gap on a single line', () => {
    const warnings = serviceWarnings(state([linked], [decision()]));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('service used through a client but not evaluated: component speech decided adopt pypi:client');
    expect(warnings[0]).toContain('service_ref');
    expect(warnings[0]).not.toContain('\n');
    expect(serviceWarnings(state([], []))).toEqual([]);
  });

  it('keeps hostile characters out of the warning', () => {
    const hostile = evaluation({ ref: 'pypi:x‮y\nz', service_ref: 'saas:a/b' });
    const [w] = serviceWarnings(state([hostile], [decision({ ref: hostile.ref })]));
    expect(w).not.toContain('‮');
    expect(w).not.toContain('\n');
  });
});

describe('upstreamProviderSignals', () => {
  it.each([
    ['BerriAI/litellm', ''],
    ['litellm', 'Call all LLM APIs using the OpenAI format'],
    ['OpenRouterTeam/openrouter-runner', ''],
    ['portkey-ai', ''],
    ['some-proxy', 'A fast LLM gateway with caching'],
    ['some-proxy', 'AI router for chat completion backends'],
    ['some-proxy', 'An OpenAI-compatible proxy for local servers'],
    ['some-lib', 'One interface for 100+ LLMs'],
    ['some-lib', 'Works with multiple LLM providers'],
    ['some-lib', 'A unified API for many large language models and providers'],
  ])('flags %s (%s)', (id, descriptor) => {
    expect(upstreamProviderSignals(id, descriptor).length).toBeGreaterThan(0);
  });

  it.each([
    ['livekit/agents', 'Build real-time multimodal AI agents to see, hear, and speak'],
    ['supabase/supabase', 'The Postgres development platform. Supabase gives you a dedicated Postgres database to build your web, mobile, and AI applications.'],
    ['langfuse', 'Open source LLM engineering platform: observability, evals, prompt management. Integrates with LiteLLM and the OpenAI SDK.'],
    ['mem0ai', 'Long-term memory for AI agents'],
    ['openai', 'Official Python library for the OpenAI API'],
    ['api-gateway-kit', 'A Kong plugin for an API gateway'],
    ['left-pad', ''],
  ])('does not flag %s', (id, descriptor) => {
    expect(upstreamProviderSignals(id, descriptor)).toEqual([]);
  });

  it('matches gateway tokens on whole name parts only', () => {
    expect(upstreamProviderSignals('litellmish', '')).toEqual([]);
    expect(upstreamProviderSignals('lite-llm', '')).toEqual([]);
    expect(upstreamProviderSignals('BerriAI/litellm', '')).toEqual(['name mentions litellm']);
  });

  it('stays fast and bounded on hostile descriptions', () => {
    const hostile = `unified api for ${'a '.repeat(50000)}`;
    const started = Date.now();
    upstreamProviderSignals('x', hostile);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('upstream provider gaps and not_stated warnings', () => {
  const gateway = evaluation({ ref: 'pypi:litellm', flags: ['upstream_provider_unverified'] });
  const gatewayDecision = decision({ ref: 'pypi:litellm' });

  it('reports a decided gateway that is flagged, whatever no_service_reason says', () => {
    const gaps = serviceUsageGaps(state([{ ...gateway, no_service_reason: 'Provider choice is a separate decision.' }], [gatewayDecision]));
    expect(gaps).toEqual([expect.objectContaining({ ref: 'pypi:litellm', kind: 'upstream_provider' })]);
    expect(gaps[0]?.reason).toContain('no_service_reason does not clear this');
    expect(serviceUsageGaps(state([gateway], [decision({ ref: 'pypi:litellm', decision: 'reference' })]))).toEqual([]);
  });

  it('words the gateway warning around the provider, on one line', () => {
    const [w] = serviceWarnings(state([gateway], [gatewayDecision]));
    expect(w).toContain('LLM gateway used without an evaluated provider: component speech decided adopt pypi:litellm');
    expect(w).toContain('service_ref');
    expect(w).toContain('weights_ref');
    expect(w).not.toContain('\n');
  });

  it('keeps the kind of the older gaps', () => {
    expect(serviceUsageGaps(state([evaluation({ service_ref: 'saas:acme/api' })], [decision()]))[0]?.kind).toBe('service_terms');
    expect(serviceUsageGaps(state([evaluation({ flags: ['service_client_suspected'] })], [decision()]))[0]?.kind).toBe('client_suspected');
  });

  it('warns about a decided service whose vendor does not state its data use', () => {
    const saas = evaluation({ ref: 'saas:acme/api', profile: 'saas', flags: ['saas_data_use_not_stated'] });
    const warnings = serviceWarnings(state([saas], [decision({ ref: 'saas:acme/api' })]));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('vendor does not state its data use: component speech decided saas:acme/api');
    expect(warnings[0]).toContain('DPA');
    expect(serviceWarnings(state([saas], [decision({ ref: 'saas:acme/api', decision: 'reference' })]))).toEqual([]);
    expect(serviceWarnings(state([evaluation({ ref: 'saas:acme/api', flags: [] })], [decision({ ref: 'saas:acme/api' })]))).toEqual([]);
  });
});
