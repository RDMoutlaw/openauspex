import type { ValidationIssue, ValidationResult } from './types.js';

/** Accumulates validation issues and produces a {@link ValidationResult}. */
export class IssueCollector {
  private readonly issues: ValidationIssue[] = [];

  error(code: string, message: string): void {
    this.issues.push({ code, message, severity: 'error' });
  }

  warn(code: string, message: string): void {
    this.issues.push({ code, message, severity: 'warn' });
  }

  result(): ValidationResult {
    return {
      valid: !this.issues.some((i) => i.severity === 'error'),
      issues: [...this.issues],
    };
  }
}
