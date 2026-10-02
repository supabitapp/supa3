const frame = new URLSearchParams(location.search).has("frame");

if (frame) {
  window.rendererReady = (async () => {
    const start = performance.now();
    const { default: mermaid } = await import("/deps/mermaid/dist/mermaid.esm.min.mjs");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "default",
      htmlLabels: false,
    });
    window.importMs = performance.now() - start;
    let id = 0;
    window.renderDiagram = async (source) => {
      const host = document.createElement("div");
      document.body.append(host);
      const started = performance.now();
      try {
        const result = await mermaid.render(`diagram${id++}`, source, host);
        return { output: result.svg, renderMs: performance.now() - started };
      } catch (error) {
        return { error: String(error), renderMs: performance.now() - started };
      } finally {
        host.remove();
      }
    };
    window.ready = true;
  })();
} else {
  const { fixtures } = await import("/fixtures.mjs");
  const percentile = (numbers, fraction) => {
    if (!numbers.length) return null;
    return [...numbers].sort((a, b) => a - b)[
      Math.max(0, Math.ceil(numbers.length * fraction) - 1)
    ];
  };
  window.benchmark = async (fixtureId, trials = 3, iterations = 10) => {
    const fixture = fixtures.find((value) => value.id === fixtureId);
    if (!fixture) throw new Error("Unknown fixture");
    const samples = [];
    for (let trial = 0; trial < trials; trial++) {
      const started = performance.now();
      const iframe = document.createElement("iframe");
      iframe.style.cssText = "width:1200px;height:800px;position:absolute;left:-10000px";
      iframe.src = "/?frame";
      const loaded = new Promise((resolve, reject) => {
        iframe.addEventListener(
          "load",
          () =>
            iframe.contentWindow.rendererReady?.then(resolve, reject) ??
            reject(new Error("Renderer failed to load")),
          { once: true },
        );
        iframe.addEventListener("error", reject, { once: true });
      });
      document.body.append(iframe);
      try {
        await loaded;
        const sample = {
          trial,
          startupMs: performance.now() - started,
          importMs: iframe.contentWindow.importMs,
          responses: [],
        };
        for (let iteration = 0; iteration <= iterations; iteration++) {
          const response = await iframe.contentWindow.renderDiagram(fixture.source);
          if (iteration === 0) sample.coldMs = performance.now() - started;
          const output = response.output ?? "";
          const parsed = new DOMParser().parseFromString(output, "image/svg+xml");
          const text = [...parsed.querySelectorAll("text")]
            .map((node) => node.textContent)
            .join(" ");
          sample.responses.push({
            iteration,
            renderMs: response.renderMs,
            bytes: new TextEncoder().encode(output).length,
            error: response.error ?? null,
            missingLabels: fixture.labels.filter((label) => !text.includes(label)),
            rejectedMalformed: fixture.expectError ? Boolean(response.error) : null,
          });
          if (trial === 0 && iteration === 0 && output) {
            const saved = await fetch(`/output/${fixtureId}.svg`, { method: "POST", body: output });
            if (!saved.ok) throw new Error(`Output save failed: ${saved.status}`);
          }
          if (response.error) break;
        }
        samples.push(sample);
      } finally {
        iframe.remove();
      }
    }
    const warm = samples.flatMap((sample) =>
      sample.responses.filter((response) => response.iteration > 0 && !response.error),
    );
    const result = {
      fixture: fixtureId,
      source: fixture.source,
      expectedLabels: fixture.labels,
      expectError: fixture.expectError ?? false,
      coldMedianMs: percentile(
        samples.map((sample) => sample.coldMs),
        0.5,
      ),
      warmMedianMs: percentile(
        warm.map((response) => response.renderMs),
        0.5,
      ),
      warmP95Ms: percentile(
        warm.map((response) => response.renderMs),
        0.95,
      ),
      samples,
    };
    const saved = await fetch("/result", {
      method: "POST",
      body: JSON.stringify({
        environment: { userAgent: navigator.userAgent, visibility: document.visibilityState },
        trials,
        iterations,
        result,
      }),
    });
    if (!saved.ok) throw new Error(`Result save failed: ${saved.status}`);
    return {
      fixture: fixtureId,
      coldMs: result.coldMedianMs,
      warmMs: result.warmMedianMs,
      missingLabels: samples[0]?.responses[0]?.missingLabels,
      error: samples[0]?.responses[0]?.error,
    };
  };
  const button = document.createElement("button");
  button.textContent = `Run ${fixtures.length} generated fixtures`;
  const status = document.createElement("pre");
  status.textContent =
    "Three fresh frames per fixture, ten warm renders per frame. Results save to the server output directory. Conversion only; excludes final paint.";
  button.addEventListener("click", async () => {
    button.disabled = true;
    status.textContent = "";
    try {
      for (const fixture of fixtures) {
        const result = await window.benchmark(fixture.id);
        status.textContent += `${JSON.stringify(result)}\n`;
      }
    } catch (error) {
      status.textContent += String(error);
    } finally {
      button.disabled = false;
    }
  });
  document.body.replaceChildren(button, status);
  window.fixtureIds = fixtures.map((fixture) => fixture.id);
}
