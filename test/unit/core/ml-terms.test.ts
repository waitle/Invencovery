import { describe, expect, it } from 'vitest';
import { mlTermsIn, soundsLikeMl } from '../../../src/core/ml-terms.js';

describe('mlTermsIn', () => {
  it('finds model tooling in free text with strong terms', () => {
    expect(mlTermsIn('Runs an ONNX model with safetensors weights', 'strong')).toEqual(['onnx', 'safetensors']);
    expect(soundsLikeMl('Speech-to-text with Whisper', 'strong')).toBe(true);
  });

  it('catches the turn-detector name (the motivating case)', () => {
    expect(soundsLikeMl('livekit-plugins-turn-detector', 'any')).toBe(true);
    expect(soundsLikeMl('turn detection for voice agents', 'strong')).toBe(true);
    expect(mlTermsIn('turn-detector', 'any')).toContain('detector');
  });

  it('trusts task words only in names and keyword lists', () => {
    expect(soundsLikeMl('A fast voice recorder utility', 'strong')).toBe(false);
    expect(soundsLikeMl('voice', 'any')).toBe(true);
    expect(soundsLikeMl('Image classification helpers', 'strong')).toBe(false);
    expect(soundsLikeMl('classification', 'any')).toBe(true);
  });

  it('matches whole words only', () => {
    expect(soundsLikeMl('Dependency injection container', 'any')).toBe(false);
    expect(soundsLikeMl('A bertha helper', 'any')).toBe(false);
    expect(soundsLikeMl('BERT embeddings', 'strong')).toBe(true);
  });

  it('does not treat generic words as ML', () => {
    expect(soundsLikeMl('A data model and view model for forms', 'any')).toBe(false);
    expect(soundsLikeMl('markdown parser', 'any')).toBe(false);
    expect(soundsLikeMl('', 'any')).toBe(false);
  });

  it('understands Korean terms with attached particles', () => {
    expect(soundsLikeMl('음성인식을 사용하는 앱', 'strong')).toBe(true);
    expect(soundsLikeMl('딥러닝 기반 분류', 'strong')).toBe(true);
    expect(soundsLikeMl('번역 기능', 'any')).toBe(true);
    expect(soundsLikeMl('번역 기능', 'strong')).toBe(false);
    expect(soundsLikeMl('로그인 화면', 'any')).toBe(false);
  });

  it('matches hyphenated and spaced spellings alike', () => {
    expect(soundsLikeMl('pre trained network', 'strong')).toBe(true);
    expect(soundsLikeMl('pretrained network', 'strong')).toBe(true);
    expect(soundsLikeMl('text to speech', 'strong')).toBe(true);
    expect(soundsLikeMl('text-to-speech', 'strong')).toBe(true);
  });

  it('treats embeddings as a feature word for the weights purpose and as model tooling for search', () => {
    const description = 'Postgres client with vector embeddings support';
    expect(soundsLikeMl(description, 'strong', 'search')).toBe(true);
    expect(soundsLikeMl(description, 'strong', 'weights')).toBe(false);
    // A name or keyword list is a deliberate choice, so it still counts.
    expect(soundsLikeMl('sentence-embeddings', 'any', 'weights')).toBe(true);
    expect(soundsLikeMl('임베딩 검색', 'strong', 'weights')).toBe(false);
    // Real model tooling in the same text still counts.
    expect(soundsLikeMl('Embeddings via ONNX runtime', 'strong', 'weights')).toBe(true);
  });
});
