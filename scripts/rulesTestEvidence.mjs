const EVALUATION_FAILURE = /(?:maximum of\s+[0-9,]+\s+expressions(?:\s+to\s+evaluate)?\s+has been reached|expression[- ]limit|EvaluationException|Null value error|Property .+ is undefined|ArrayIndexOutOfBoundsException|Index(?:\s+\d+)? out of bounds|Unable to evaluate|Type error|Invalid argument|Function not found error)/i;
const EXPECTED_DENIAL = /^(?:evaluation error at L\d+:\d+ for '(?:get|list|create|update|delete)' @ L\d+,\s*)+(?:false for '(?:get|list|create|update|delete)' @ L\d+)(?:,\s*false for '(?:get|list|create|update|delete)' @ L\d+)*$/;

export function rulesEvaluationFailures(text) {
  if (typeof text !== 'string') throw new TypeError('Rules evidence must be text');
  // Emulator 1.21.0 emits a preliminary "evaluation error ... , false for ..."
  // for an ordinary RBAC get() predicate that ultimately returns false. Native
  // constant-false/RBAC-false/undefined-property controls establish the split.
  // Concrete exceptions always fail, including on lines that also contain false.
  return [...new Set(text.split(/\r?\n/).filter(line => EVALUATION_FAILURE.test(line)
    || (/evaluation error/i.test(line) && !EXPECTED_DENIAL.test(line.trim()))))];
}

export function rulesExpectedDenialDiagnostics(text) {
  return [...new Set(text.split(/\r?\n/).filter(line => EXPECTED_DENIAL.test(line.trim())
    && !EVALUATION_FAILURE.test(line)))];
}

export function verifyRulesEvidence({ log, output, report, expectedFile }) {
  const failures = rulesEvaluationFailures(`${log}\n${output}`);
  if (typeof log !== 'string' || !log.trim()) failures.push('Missing emulator log');
  if (!report || report.success !== true || !Number.isInteger(report.numTotalTests) || report.numTotalTests < 34
    || report.numPassedTests !== report.numTotalTests || report.numFailedTests !== 0
    || report.numPendingTests !== 0 || report.numTodoTests !== 0
    || !Array.isArray(report.testResults) || report.testResults.length !== 1
    || typeof report.testResults[0]?.name !== 'string'
    || typeof expectedFile !== 'string' || report.testResults[0].name !== expectedFile
    || report.testResults[0].status !== 'passed'
    || !Array.isArray(report.testResults[0].assertionResults)
    || report.testResults[0].assertionResults.length !== report.numTotalTests
    || report.testResults[0].assertionResults.some(test => !test || test.status !== 'passed'
      || !Array.isArray(test.failureMessages) || test.failureMessages.length !== 0)
    || report.numFailedTestSuites !== 0) {
    failures.push('Rules test report is missing, incomplete, failed or skipped');
  }
  return { ok: failures.length === 0, failures,
    expectedDenialDiagnostics: rulesExpectedDenialDiagnostics(`${log}\n${output}`) };
}
