import { createDiagramRenderer } from "@t3tools/client-runtime/diagram-rendering";
import { MERMAID_ASCII_LIMITS } from "@t3tools/mermaid-ascii/limits";

export function createBrowserDiagramRenderer() {
  let worker: Worker | undefined;
  let ready = false;

  return createDiagramRenderer(
    (source) =>
      new Promise<string | null>((resolve, reject) => {
        const activeWorker = (worker ??= new Worker(
          new URL("./mermaid.worker.ts", import.meta.url),
          {
            type: "module",
          },
        ));
        let settled = false;
        let sent = false;
        const finish = (output: string | null, terminate = false) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          activeWorker.removeEventListener("message", handleMessage);
          activeWorker.removeEventListener("error", handleError);
          activeWorker.removeEventListener("messageerror", handleMessageError);
          if (terminate) {
            activeWorker.terminate();
            worker = undefined;
            ready = false;
            reject(new Error("Diagram preview unavailable"));
          } else {
            resolve(output);
          }
        };
        let timer = setTimeout(() => finish(null, true), 15_000);
        const send = () => {
          if (sent) return;
          sent = true;
          clearTimeout(timer);
          timer = setTimeout(() => finish(null, true), MERMAID_ASCII_LIMITS.durationMs * 2);
          try {
            activeWorker.postMessage({ source }, []);
          } catch {
            finish(null, true);
          }
        };
        const handleMessage = (event: MessageEvent<unknown>) => {
          if (
            typeof event.data === "object" &&
            event.data !== null &&
            "ready" in event.data &&
            event.data.ready === true &&
            !sent
          ) {
            ready = true;
            send();
          } else if (
            sent &&
            typeof event.data === "object" &&
            event.data !== null &&
            "output" in event.data &&
            typeof event.data.output === "string"
          ) {
            finish(event.data.output);
          } else if (
            sent &&
            typeof event.data === "object" &&
            event.data !== null &&
            "error" in event.data &&
            event.data.error === true
          ) {
            finish(null);
          } else {
            finish(null, true);
          }
        };
        const handleError = (event: ErrorEvent) => {
          event.preventDefault();
          finish(null, true);
        };
        const handleMessageError = () => finish(null, true);
        activeWorker.addEventListener("message", handleMessage);
        activeWorker.addEventListener("error", handleError);
        activeWorker.addEventListener("messageerror", handleMessageError);
        if (ready) send();
      }),
  );
}

const renderer = createBrowserDiagramRenderer();

export function renderMermaidDiagram(source: string) {
  return renderer.render(source);
}
