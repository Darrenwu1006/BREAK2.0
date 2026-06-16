import process from "node:process";
import packageJson from "../../package.json";
import type { BatchReport, MatrixReport } from "./benchmark";

export const BENCHMARK_REPORT_SCHEMA_VERSION = "m8-benchmark-report-v1";

export interface BenchmarkReportEnvelope {
  schemaVersion: typeof BENCHMARK_REPORT_SCHEMA_VERSION;
  kind: "batch" | "matrix";
  generatedAt: string;
  command: string[];
  metadata: {
    appName: string;
    appVersion: string;
    engineVersion: string;
    nodeVersion: string;
    benchmarkSchemaVersion: typeof BENCHMARK_REPORT_SCHEMA_VERSION;
  };
  report: BatchReport | MatrixReport;
}

export function createBenchmarkReportEnvelope(
  kind: "batch" | "matrix",
  report: BatchReport | MatrixReport,
  command: string[],
  generatedAt = new Date().toISOString(),
): BenchmarkReportEnvelope {
  return {
    schemaVersion: BENCHMARK_REPORT_SCHEMA_VERSION,
    kind,
    generatedAt,
    command: [...command],
    metadata: {
      appName: packageJson.name,
      appVersion: packageJson.version,
      engineVersion: packageJson.version,
      nodeVersion: process.version,
      benchmarkSchemaVersion: BENCHMARK_REPORT_SCHEMA_VERSION,
    },
    report,
  };
}

