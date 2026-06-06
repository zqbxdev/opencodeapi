// Test streaming through the proxy
const resp = await fetch("http://localhost:4097/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "deepseek-v4-flash-free",
    messages: [{ role: "user", content: "say hi in one word" }],
    stream: true,
  }),
});

console.log("Status:", resp.status);
console.log("Headers:", JSON.stringify([...resp.headers]));

let count = 0;
const reader = resp.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  count++;
  const text = decoder.decode(value, { stream: true });
  const lines = text.split("\n").filter(l => l.trim());
  for (const line of lines) {
    if (line.startsWith("data: ") && line !== "data: [DONE]") {
      process.stdout.write(".");
    }
  }
}
console.log("\nTotal raw chunks received:", count);
