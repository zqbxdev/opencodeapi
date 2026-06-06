import http from "http";

const CONCURRENCY = 3;
const REQUEST_TIMEOUT = 10000;
const MODELS = ["deepseek-v4-flash-free", "big-pickle", "mimo-v2.5-free"];

async function makeRequest(id, useStream, model) {
  const start = Date.now();
  const data = JSON.stringify({
    model,
    messages: [{ role: "user", content: `Hello task ${id}, say pong` }],
    stream: useStream,
  });

  return new Promise((resolve) => {
    let timer;
    const req = http.request(
      {
        hostname: "localhost",
        port: 4097,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let chunkCount = 0;
        let body = "";

        res.on("data", (chunk) => {
          chunkCount++;
          body += chunk.toString();
        });

        res.on("end", () => {
          clearTimeout(timer);
          const duration = Date.now() - start;
          resolve({
            id,
            status: res.statusCode,
            chunks: chunkCount,
            duration,
            success: res.statusCode === 200 && body.length > 0,
            error: res.statusCode !== 200 ? `Status ${res.statusCode}` : null,
          });
        });

        res.on("error", (e) => {
          clearTimeout(timer);
          resolve({
            id,
            status: 0,
            duration: Date.now() - start,
            success: false,
            error: e.message,
          });
        });
      }
    );

    req.on("error", (e) => {
      clearTimeout(timer);
      resolve({
        id,
        status: 0,
        duration: Date.now() - start,
        success: false,
        error: e.message,
      });
    });

    timer = setTimeout(() => {
      req.destroy();
      resolve({
        id,
        status: 0,
        duration: Date.now() - start,
        success: false,
        error: "Timeout",
      });
    }, REQUEST_TIMEOUT);

    req.write(data);
    req.end();
  });
}

async function runStressTest() {
  console.log(`Starting stress test: ${CONCURRENCY} concurrent requests`);
  const promises = [];

  for (let i = 0; i < CONCURRENCY; i++) {
    const useStream = i % 2 === 0;
    const model = MODELS[i % MODELS.length];
    promises.push(makeRequest(i + 1, useStream, model));
  }

  const results = await Promise.all(promises);

  let successCount = 0;
  let errorCount = 0;
  let totalDuration = 0;

  console.log("\n--- Detailed Results ---");
  for (const r of results) {
    totalDuration += r.duration;
    if (r.success) {
      successCount++;
      console.log(`Req ${r.id}: SUCCESS | Duration: ${r.duration}ms | Chunks: ${r.chunks} | Status: ${r.status}`);
    } else {
      errorCount++;
      console.log(`Req ${r.id}: FAILED  | Duration: ${r.duration}ms | Error: ${r.error}`);
    }
  }

  console.log("\n--- Summary ---");
  console.log(`Total Requests: ${CONCURRENCY}`);
  console.log(`Successes:      ${successCount}`);
  console.log(`Failures:       ${errorCount}`);
  console.log(`Average Time:   ${Math.round(totalDuration / CONCURRENCY)}ms`);

  if (errorCount > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runStressTest();
