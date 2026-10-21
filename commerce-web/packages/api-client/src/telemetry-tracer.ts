import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { WebTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-web";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";

// Loaded only when a deployment explicitly enables browser tracing.
export function createTracedFetch(endpoint: string) {
const provider=new WebTracerProvider({resource:resourceFromAttributes({"service.name":typeof location!=="undefined"&&location.port==="5174"?"commerce-admin":"commerce-storefront"}),spanProcessors:[new BatchSpanProcessor(new OTLPTraceExporter({url:endpoint}),{maxQueueSize:256,maxExportBatchSize:64,scheduledDelayMillis:1000,exportTimeoutMillis:3000})]});
const tracer=provider.getTracer("commerce-browser");
  return async (request: Request): Promise<Response> => {
  const url=new URL(request.url);
  if(url.origin!==location.origin||!url.pathname.startsWith("/api/"))return fetch(request);
  const route=url.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi,":id");
  const span=tracer.startSpan(`${request.method} ${route}`,{kind:SpanKind.CLIENT,attributes:{"http.request.method":request.method,"http.route":route}});
  const context=span.spanContext();
  request.headers.set("traceparent",`00-${context.traceId}-${context.spanId}-01`);
  try{const response=await fetch(request);span.setAttribute("http.response.status_code",response.status);if(response.status>=500)span.setStatus({code:SpanStatusCode.ERROR});return response;}
  catch(error){span.setStatus({code:SpanStatusCode.ERROR,message:"Network request failed"});throw error;}
  finally{span.end();}
};

}
