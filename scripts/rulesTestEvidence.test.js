import { describe, expect, it } from 'vitest';
import { rulesEvaluationFailures, verifyRulesEvidence } from './rulesTestEvidence.mjs';

const report = { success: true, numTotalTests: 34, numPassedTests: 34, numFailedTests: 0,
  numPendingTests: 0, numTodoTests: 0, numFailedTestSuites: 0,
  testResults: [{ name: '/synthetic/firestore.rules.test.js', status: 'passed',
    assertionResults: Array.from({ length: 34 }, () => ({ status: 'passed', failureMessages: [] })) }] };
const evidence = { report, expectedFile: '/synthetic/firestore.rules.test.js', log: 'Firestore emulator started\nfalse for update @ L442\nPERMISSION_DENIED', output: '34 passed' };

describe('Firestore rules verification evidence', () => {
  it('allows ordinary explicit denial and expected create-only conflict logs', () => {
    expect(verifyRulesEvidence({ ...evidence, log: `${evidence.log}\nALREADY_EXISTS\nNOT_FOUND` }).ok).toBe(true);
    expect(rulesEvaluationFailures('AsyncTwoPhaseRulesAuthorizer.java:1000')).toEqual([]);
    expect(rulesEvaluationFailures("evaluation error at L1:501 for 'get' @ L1, false for 'get' @ L1")).toEqual([]);
    expect(rulesEvaluationFailures("Property email is undefined on object, false for 'get' @ L1")).toHaveLength(1);
  });
  it.each([
    'Unable to evaluate the expression as the maximum of 1000 expressions to evaluate has been reached.',
    'maximum of 1,000 expressions has been reached', 'expression-limit exhaustion',
    'evaluation error at L430:24', 'com.google.firebase.rules.runtime.common.EvaluationException',
    'Null value error.', 'Property email is undefined on object.', 'Index out of bounds',
    'Function not found error: Name: [in].',
    'java.lang.ArrayIndexOutOfBoundsException: Index 0 out of bounds for length 0',
    'Index 3 out of bounds for length 2',
  ])('rejects evaluator failure even with all-green assertion totals: %s', message => {
    expect(verifyRulesEvidence({ ...evidence, log: message }).ok).toBe(false);
    expect(verifyRulesEvidence({ ...evidence, output: message }).ok).toBe(false);
  });
  it.each([null, { ...report, numPassedTests: 33 }, { ...report, numPendingTests: 1 },
    { ...report, numTodoTests: 1 }, { ...report, numTotalTests: 0, numPassedTests: 0 },
    { ...report, testResults: [] }, { ...report, testResults: [{ name: 7 }] },
    { ...report, success: 'true' }, { ...report, success: false }])('rejects incomplete or skipped reports', report => {
    expect(verifyRulesEvidence({ ...evidence, report }).ok).toBe(false);
  });
  it('requires a nonempty emulator log', () => {
    expect(verifyRulesEvidence({ ...evidence, log: '' }).ok).toBe(false);
  });
  it('recognizes native mixed-ID query denial with leading false clauses', () => {
    const benign = "false for 'list' @ L501, evaluation error at L501:26 for 'list' @ L501, false for 'list' @ L501";
    expect(verifyRulesEvidence({ ...evidence, log: benign }).ok).toBe(true);
    expect(verifyRulesEvidence({ ...evidence, log: benign }).expectedDenialDiagnostics).toEqual([benign]);
    expect(rulesEvaluationFailures(`false for 'get' @ L10, ${benign}`)).toEqual([]);
  });
  it.each([
    "false for 'list' @ L501, evaluation error at L501:26 for 'list' @ L501",
    "true for 'list' @ L501, evaluation error at L501:26 for 'list' @ L501, false for 'list' @ L501",
    "false for 'list' @ L501, evaluation error: unexpected detail, false for 'list' @ L501",
    "false for 'list' @ L501, evaluation error at L501:26 for 'list' @ L501, false for 'list' @ L501 unknown suffix",
  ])('keeps the mixed-query diagnostic exemption bounded: %s', log => {
    expect(verifyRulesEvidence({ ...evidence, log }).ok).toBe(false);
  });
  it('rejects concrete errors beside native mixed-query false clauses', () => {
    const benign = "false for 'list' @ L501, evaluation error at L501:26 for 'list' @ L501, false for 'list' @ L501";
    for (const separator of [', ', '\n']) for (const fault of ['Null value error.',
      'Function not found error: Name: [in].', 'java.lang.ArrayIndexOutOfBoundsException: Index 0 out of bounds for length 0',
      'maximum of 1000 expressions has been reached']) {
      expect(verifyRulesEvidence({ ...evidence, log: benign + separator + fault }).ok).toBe(false);
    }
  });
  it('does not let a benign diagnostic hide a concrete same-line or later exception', () => {
    const benign = "evaluation error at L1:501 for 'get' @ L1, false for 'get' @ L1";
    for (const separator of [', ', '\n']) expect(verifyRulesEvidence({ ...evidence,
      log: benign + separator + 'Caused by: com.google.firebase.rules.runtime.common.EvaluationException: Error: Null value error.' }).ok).toBe(false);
    expect(verifyRulesEvidence({ ...evidence, log: benign }).expectedDenialDiagnostics).toEqual([benign]);
  });
  it.each([
    "evaluation error: unsupported operator. false for 'get' @ L1",
    "evaluation error at L1:2 for 'get' @ L1, false for 'get' @ L1, true for 'get' @ L1",
    "evaluation error at L1:2 for 'get' @ L1, false for 'get' @ L1 unexpected detail",
  ])('rejects unrecognized diagnostic grammar: %s', log => {
    expect(verifyRulesEvidence({ ...evidence, log }).ok).toBe(false);
  });
  it('binds report identity and checks individual suite/assertion evidence', () => {
    expect(verifyRulesEvidence({ ...evidence, expectedFile: '/other/firestore.rules.test.js' }).ok).toBe(false);
    for (const change of [{ status: 'failed' }, { assertionResults: [] },
      { assertionResults: report.testResults[0].assertionResults.map((value, index) => index ? value : { status: 'skipped', failureMessages: [] }) }]) {
      expect(verifyRulesEvidence({ ...evidence, report: { ...report,
        testResults: [{ ...report.testResults[0], ...change }] } }).ok).toBe(false);
    }
  });
});
