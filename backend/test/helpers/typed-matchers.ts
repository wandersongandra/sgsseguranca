export const stringContainingMatcher = (
  expected: string,
): jest.AsymmetricMatcher => ({
  asymmetricMatch: (received: unknown): boolean =>
    typeof received === 'string' && received.includes(expected),
});

export const stringMatchingMatcher = (
  expected: RegExp,
): jest.AsymmetricMatcher => ({
  asymmetricMatch: (received: unknown): boolean =>
    typeof received === 'string' && new RegExp(expected).test(received),
});
