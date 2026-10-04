// @effect-diagnostics nodeBuiltinImport:off - fatal monitoring requires synchronous child dispatch and descriptor reads before Node exits.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeSea from "node:sea";
import * as NodeCrypto from "node:crypto";
import { ExceptionReport as ExceptionReportSchema } from "@supacode/contracts";
import { exceptionProperties } from "@supacode/shared/errorTracking";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

const FatalReport = Schema.Struct({
  report: ExceptionReportSchema,
  identifier: Schema.String,
  key: Schema.String,
  host: Schema.String,
  properties: Schema.Record(Schema.String, Schema.Unknown),
});
type FatalReport = typeof FatalReport.Type;
const decodeFatalReport = Schema.decodeUnknownSync(FatalReport);

/** The monitor cannot await network I/O before Node exits. A bounded child preserves fatal exit behavior. */
export function deliverFatalException(input: FatalReport) {
  try {
    const payload = JSON.stringify(input);
    if (payload.length > 128_000) return;
    const entry = process.argv[1];
    if (!NodeSea.isSea() && !entry) return;
    NodeChildProcess.spawnSync(
      process.execPath,
      NodeSea.isSea() ? ["report-error"] : [entry ?? "", "report-error"],
      {
        input: payload,
        timeout: 2_500,
        stdio: ["pipe", "ignore", "ignore"],
      },
    );
  } catch {
    /* Fatal reporting must never replace the original failure. */
  }
}

/** Internal child command: no user state, provider loading, or persistent retry queue. */
export async function runFatalDelivery() {
  try {
    const raw = NodeFS.readFileSync(0, "utf8");
    if (raw.length > 128_000) return;
    const input = decodeFatalReport(JSON.parse(raw));
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const timestamp = DateTime.formatIso(yield* DateTime.now);
        const request = yield* HttpClientRequest.post(`${input.host}/batch/`).pipe(
          HttpClientRequest.bodyJson({
            api_key: input.key,
            batch: [
              {
                uuid: NodeCrypto.randomUUID(),
                event: "$exception",
                distinct_id: input.identifier,
                properties: { ...input.properties, ...exceptionProperties(input.report) },
                timestamp,
              },
            ],
          }),
        );
        yield* client.execute(request).pipe(Effect.timeout("2 seconds"));
      }).pipe(Effect.provide(NodeHttpClient.layerNodeHttp)),
    );
  } catch {
    /* Best effort when the parent process is already failing. */
  }
}
