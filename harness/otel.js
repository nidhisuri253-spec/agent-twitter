// OpenTelemetry setup for the harness.
// Uses BasicTracerProvider with a JSONL file exporter — fully offline, no backend needed.
// Import this module before any spans are created; the side effects (provider.register())
// run at import time.

import { BasicTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
export const TELEMETRY_FILE = join(__dir, 'telemetry.jsonl');

// Clear on each run so the report always reflects the most recent invocation.
writeFileSync(TELEMETRY_FILE, '');

function hrToMs([sec, ns]) {
  return sec * 1000 + ns / 1_000_000;
}

// Minimal SpanExporter: serialises each completed span as a JSON line.
const jsonlExporter = {
  export(spans, cb) {
    for (const span of spans) {
      const startMs = hrToMs(span.startTime);
      const endMs   = span.endTime[0] ? hrToMs(span.endTime) : startMs;
      appendFileSync(TELEMETRY_FILE, JSON.stringify({
        name:       span.name,
        startMs:    +startMs.toFixed(2),
        durationMs: +(endMs - startMs).toFixed(2),
        otelStatus: span.status.code,   // 0=UNSET 1=OK 2=ERROR
        attrs:      { ...span.attributes },
      }) + '\n');
    }
    cb({ code: 0 });
  },
  shutdown() { return Promise.resolve(); },
};

const provider = new BasicTracerProvider();
provider.addSpanProcessor(new SimpleSpanProcessor(jsonlExporter));
provider.register();

export const tracer = trace.getTracer('agent-twitter-harness', '1.0.0');
export { SpanStatusCode };
